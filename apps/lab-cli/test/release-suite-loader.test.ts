import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadReleaseSuite } from '../src/release-suite-loader.js';

const root = '/repo';
const identityRealPath = async (path: string): Promise<string> => path;
const scenario = {
  name: 'release-case',
  commands: [{ type: 'assert_quiescent' }],
};
const entry = {
  id: 'release-case',
  scenario: 'scenarios/release-case.json',
  transports: ['http'],
  senderDurability: 'persistent',
  receiverDurability: 'restart_safe',
  requiredInvariants: ['reproducibility', 'no-unsupported-pass'],
};

function reader(files: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string> => {
    const value = files[path];
    if (value === undefined) throw new Error('missing');
    return value;
  };
}

function suite(overrides: Readonly<Record<string, unknown>> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    profile: 'delivery-v1',
    scenarios: [entry],
    ...overrides,
  });
}

describe('release suite loader', () => {
  it('loads and validates repository-confined scenario specifications', async () => {
    const loaded = await loadReleaseSuite({
      repositoryRoot: root,
      path: 'spec/release-suite.json',
      realPath: identityRealPath,
      readText: reader({
        [resolve(root, 'spec/release-suite.json')]: suite(),
        [resolve(root, entry.scenario)]: JSON.stringify(scenario),
      }),
    });

    expect(loaded.scenarios).toEqual([{ ...entry, spec: scenario }]);
    expect(loaded.digest).toBe(
      'sha256:63fde51d9355ba7e19568750ee6ceb9b0164bea2fd581ef7109331f155f4639f',
    );
  });

  it('changes the bundle digest when scenario bytes change', async () => {
    const files = (scenarioText: string) => ({
      [resolve(root, 'spec/release-suite.json')]: suite(),
      [resolve(root, entry.scenario)]: scenarioText,
    });
    const first = await loadReleaseSuite({
      repositoryRoot: root,
      path: 'spec/release-suite.json',
      realPath: identityRealPath,
      readText: reader(files(JSON.stringify(scenario))),
    });
    const second = await loadReleaseSuite({
      repositoryRoot: root,
      path: 'spec/release-suite.json',
      realPath: identityRealPath,
      readText: reader(files(`${JSON.stringify(scenario)}\n`)),
    });

    expect(first.digest).not.toBe(second.digest);
  });

  it.each(['/tmp/release-suite.json', '../release-suite.json'])(
    'rejects a non-confined suite path: %s',
    async (path) => {
      await expect(
        loadReleaseSuite({
          repositoryRoot: root,
          path,
          readText: reader({}),
          realPath: identityRealPath,
        }),
      ).rejects.toThrow('repository-relative');
    },
  );

  it('rejects oversized suite input before parsing it', async () => {
    await expect(
      loadReleaseSuite({
        repositoryRoot: root,
        path: 'spec/release-suite.json',
        realPath: identityRealPath,
        readText: reader({
          [resolve(root, 'spec/release-suite.json')]: ' '.repeat(256 * 1024 + 1),
        }),
      }),
    ).rejects.toThrow('maximum file size');
  });

  it('rejects invalid JSON and invalid suite schemas', async () => {
    await expect(
      loadReleaseSuite({
        repositoryRoot: root,
        path: 'spec/release-suite.json',
        realPath: identityRealPath,
        readText: reader({ [resolve(root, 'spec/release-suite.json')]: '{' }),
      }),
    ).rejects.toThrow('not valid JSON');
    await expect(
      loadReleaseSuite({
        repositoryRoot: root,
        path: 'spec/release-suite.json',
        realPath: identityRealPath,
        readText: reader({
          [resolve(root, 'spec/release-suite.json')]: suite({ schemaVersion: 2 }),
        }),
      }),
    ).rejects.toThrow('schemaVersion');
  });

  it('rejects missing and invalid scenario files without exposing filesystem errors', async () => {
    const manifestPath = resolve(root, 'spec/release-suite.json');
    await expect(
      loadReleaseSuite({
        repositoryRoot: root,
        path: 'spec/release-suite.json',
        realPath: identityRealPath,
        readText: reader({ [manifestPath]: suite() }),
      }),
    ).rejects.toThrow('Release suite scenario release-case was not found');
    await expect(
      loadReleaseSuite({
        repositoryRoot: root,
        path: 'spec/release-suite.json',
        realPath: identityRealPath,
        readText: reader({
          [manifestPath]: suite(),
          [resolve(root, entry.scenario)]: JSON.stringify({ name: 'bad', commands: [{}] }),
        }),
      }),
    ).rejects.toThrow('is invalid');
  });

  it('rejects manifest-controlled traversal and absolute scenario paths', async () => {
    for (const path of ['../secret.json', '/tmp/secret.json']) {
      await expect(
        loadReleaseSuite({
          repositoryRoot: root,
          path: 'spec/release-suite.json',
          realPath: identityRealPath,
          readText: reader({
            [resolve(root, 'spec/release-suite.json')]: suite({
              scenarios: [{ ...entry, scenario: path }],
            }),
          }),
        }),
      ).rejects.toThrow('scenario path is invalid');
    }
  });

  it('rejects a repository-relative scenario symlink that escapes the repository', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'cashu-release-suite-'));
    const repositoryRoot = resolve(directory, 'repository');
    const outsideScenario = resolve(directory, 'outside.json');
    const suitePath = resolve(repositoryRoot, 'spec/release-suite.json');
    const scenarioPath = resolve(repositoryRoot, entry.scenario);
    try {
      await mkdir(resolve(repositoryRoot, 'spec'), { recursive: true });
      await mkdir(resolve(repositoryRoot, 'scenarios'), { recursive: true });
      await writeFile(suitePath, suite());
      await writeFile(outsideScenario, JSON.stringify(scenario));
      await symlink(outsideScenario, scenarioPath);

      await expect(
        loadReleaseSuite({
          repositoryRoot,
          path: 'spec/release-suite.json',
          readText: async (path) => readFile(path, 'utf8'),
          realPath: realpath,
        }),
      ).rejects.toThrow('remain inside the repository');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
