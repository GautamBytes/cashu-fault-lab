import type {
  FailureArtifact,
  MatrixCaseResult,
  ScenarioRunResult,
  ScenarioSpec,
} from '@cashu-fault-lab/scenario-runner';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo, type LabRuntime } from '../src/index.js';

const artifact: FailureArtifact = {
  schemaVersion: 1,
  seed: 'seed-1',
  scenario: 'request-loss',
  commands: [{ type: 'assert_quiescent' }],
  history: [],
  capabilities: { implementation: 'fake', version: '1.0.0' },
};
const passed: ScenarioRunResult = { status: 'passed', artifact };

class FakeRuntime implements LabRuntime {
  runs = 0;
  replays = 0;
  selection: { sender: string; receiver: string } | undefined;

  async up(): Promise<void> {}

  async run(
    _scenario: ScenarioSpec,
    _seed: string,
    selection?: { sender: string; receiver: string },
  ): Promise<ScenarioRunResult> {
    this.runs += 1;
    this.selection = selection;
    return passed;
  }

  async replay(_artifact: FailureArtifact): Promise<ScenarioRunResult> {
    this.replays += 1;
    return passed;
  }

  async matrix(): Promise<readonly MatrixCaseResult[]> {
    return [
      {
        profile: 'delivery-v1',
        sender: 'fake',
        receiver: 'fake',
        status: 'passed',
      },
    ];
  }
}

function fixture(files: Readonly<Record<string, string>> = {}) {
  const stored = new Map(Object.entries(files));
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    readText: async (path) => {
      const value = stored.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    writeText: async (path, value) => {
      stored.set(path, value);
    },
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  };
  return { io, stored, stdout: () => stdout, stderr: () => stderr };
}

describe('lab CLI', () => {
  it('runs a scenario and writes a replayable result artifact', async () => {
    const scenario: ScenarioSpec = {
      name: 'request-loss',
      commands: [{ type: 'assert_quiescent' }],
    };
    const setup = fixture({ 'scenario.json': JSON.stringify(scenario) });
    const runtime = new FakeRuntime();

    const outcome = await runCli(
      [
        'node',
        'cashu-fault-lab',
        'run',
        'scenario.json',
        '--seed',
        'seed-1',
        '--artifact',
        'run.json',
        '--sender',
        'reference-ts',
        '--receiver',
        'reference-ts',
      ],
      { runtime, io: setup.io },
    );

    expect(outcome.exitCode).toBe(0);
    expect(runtime.runs).toBe(1);
    expect(runtime.selection).toEqual({ sender: 'reference-ts', receiver: 'reference-ts' });
    expect(JSON.parse(setup.stored.get('run.json')!)).toMatchObject({ status: 'passed' });
    expect(setup.stdout()).toMatch(/passed/i);
  });

  it('stores a default latest artifact and reports it when no path is given', async () => {
    const scenario: ScenarioSpec = {
      name: 'request-loss',
      commands: [{ type: 'assert_quiescent' }],
    };
    const setup = fixture({ 'scenario.json': JSON.stringify(scenario) });
    const runtime = new FakeRuntime();

    expect(
      (
        await runCli(['node', 'cashu-fault-lab', 'run', 'scenario.json'], {
          runtime,
          io: setup.io,
        })
      ).exitCode,
    ).toBe(0);
    expect(setup.stored.get('artifacts/latest.json')).toContain('"status": "passed"');

    expect(
      (
        await runCli(['node', 'cashu-fault-lab', 'report'], {
          runtime,
          io: setup.io,
        })
      ).exitCode,
    ).toBe(0);
    expect(setup.stdout()).toContain('"scenarioId": "request-loss"');
  });

  it('forces private permissions when overwriting an existing artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cashu-fault-lab-cli-'));
    const scenarioPath = join(directory, 'scenario.json');
    const artifactPath = join(directory, 'artifact.json');
    await writeFile(
      scenarioPath,
      JSON.stringify({ name: 'request-loss', commands: [{ type: 'assert_quiescent' }] }),
    );
    await writeFile(artifactPath, 'previous artifact');
    await chmod(artifactPath, 0o644);

    try {
      const outcome = await runCli(
        ['node', 'cashu-fault-lab', 'run', scenarioPath, '--artifact', artifactPath],
        { runtime: new FakeRuntime() },
      );

      expect(outcome.exitCode).toBe(0);
      expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resolves scenario shorthand under the packaged scenarios directory', async () => {
    const scenario: ScenarioSpec = {
      name: 'security-malformed-input',
      commands: [{ type: 'assert_quiescent' }],
    };
    const setup = fixture({
      'scenarios/security/malformed-input.json': JSON.stringify(scenario),
    });
    const runtime = new FakeRuntime();

    const outcome = await runCli(['node', 'cashu-fault-lab', 'run', 'security/malformed-input'], {
      runtime,
      io: setup.io,
    });

    expect(outcome.exitCode).toBe(0);
    expect(runtime.runs).toBe(1);
  });

  it('replays an artifact through the selected runtime', async () => {
    const setup = fixture({ 'artifact.json': JSON.stringify(artifact) });
    const runtime = new FakeRuntime();

    const outcome = await runCli(['node', 'cashu-fault-lab', 'replay', 'artifact.json'], {
      runtime,
      io: setup.io,
    });

    expect(outcome.exitCode).toBe(0);
    expect(runtime.replays).toBe(1);
  });

  it('fails a matrix gate when fewer than the required pairs pass', async () => {
    const setup = fixture();
    const outcome = await runCli(
      ['node', 'cashu-fault-lab', 'matrix', '--profile', 'delivery-v1', '--min-passes', '2'],
      { runtime: new FakeRuntime(), io: setup.io },
    );

    expect(outcome.exitCode).toBe(1);
    expect(setup.stderr()).toMatch(/requires at least 2 passing pairs/i);
  });

  it('renders a report file without secret-bearing artifact fields', async () => {
    const unsafe = {
      ...passed,
      artifact: {
        ...artifact,
        capabilities: { ...artifact.capabilities, secret: 'secret-a' },
      },
    };
    const setup = fixture({ 'run.json': JSON.stringify(unsafe) });

    const outcome = await runCli(
      [
        'node',
        'cashu-fault-lab',
        'report',
        'run.json',
        '--format',
        'json',
        '--output',
        'report.json',
      ],
      { runtime: new FakeRuntime(), io: setup.io },
    );

    expect(outcome.exitCode).toBe(0);
    expect(setup.stored.get('report.json')).not.toContain('secret-a');
  });

  it('returns nonzero for conformance failures and malformed input', async () => {
    const failingRuntime = new FakeRuntime();
    failingRuntime.run = async () => ({
      status: 'failed',
      artifact,
      error: { name: 'Error', message: 'failed' },
    });
    const setup = fixture({
      'scenario.json': JSON.stringify({
        name: 'request-loss',
        commands: [{ type: 'assert_quiescent' }],
      }),
      'invalid.json': '{',
    });

    expect(
      (
        await runCli(['node', 'cashu-fault-lab', 'run', 'scenario.json'], {
          runtime: failingRuntime,
          io: setup.io,
        })
      ).exitCode,
    ).toBe(1);
    expect(
      (
        await runCli(['node', 'cashu-fault-lab', 'replay', 'invalid.json'], {
          runtime: failingRuntime,
          io: setup.io,
        })
      ).exitCode,
    ).toBe(2);
  });
});
