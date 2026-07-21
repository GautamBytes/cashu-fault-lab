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
import type { AdapterManifest } from '../src/adapter-manifest.js';
import type { DoctorProbes } from '../src/doctor.js';
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
  shrinks = 0;
  shrinkRunLimit: number | undefined;
  selection: { sender: string; receiver: string } | undefined;
  adapterManifest: AdapterManifest | undefined;

  async up(): Promise<void> {}
  async down(): Promise<void> {}

  async run(
    _scenario: ScenarioSpec,
    _seed: string,
    selection?: { sender: string; receiver: string; adapterManifest?: AdapterManifest },
  ): Promise<ScenarioRunResult> {
    this.runs += 1;
    this.selection = selection;
    this.adapterManifest = selection?.adapterManifest;
    return passed;
  }

  async replay(_artifact: FailureArtifact): Promise<ScenarioRunResult> {
    this.replays += 1;
    return passed;
  }

  async shrink(_artifact: FailureArtifact, runLimit?: number): Promise<ScenarioRunResult> {
    this.shrinks += 1;
    this.shrinkRunLimit = runLimit;
    return passed;
  }

  async matrix(
    _profile?: string,
    _seed?: string,
    adapterManifest?: AdapterManifest,
  ): Promise<readonly MatrixCaseResult[]> {
    this.adapterManifest = adapterManifest;
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

  it('validates a well-formed scenario and prints ok', async () => {
    const scenario: ScenarioSpec = {
      name: 'response-lost',
      commands: [
        {
          type: 'configure_fault',
          target: 'http',
          rule: { kind: 'drop_response', occurrence: 1 },
        },
        { type: 'send', sender: 'reference', requestId: 'AAECAwQFBgcICQoLDA0ODw' },
        { type: 'assert_quiescent' },
      ],
    };
    const setup = fixture({ 'scenario.json': JSON.stringify(scenario) });

    const outcome = await runCli(['node', 'cashu-fault-lab', 'validate', 'scenario.json'], {
      io: setup.io,
    });

    expect(outcome.exitCode).toBe(0);
    expect(setup.stdout()).toMatch(/^ok response-lost \(3 commands\)/);
  });

  it('validate exits nonzero and reports the error path for a malformed scenario', async () => {
    const setup = fixture({
      'scenario.json': JSON.stringify({
        name: 'bad',
        commands: [{ type: 'configure_fault', target: 'carrier-pigeon', rule: { kind: 'drop' } }],
      }),
    });

    const outcome = await runCli(['node', 'cashu-fault-lab', 'validate', 'scenario.json'], {
      io: setup.io,
    });

    expect(outcome.exitCode).toBe(1);
    expect(setup.stderr()).toMatch(/invalid:/);
  });

  it('run rejects a scenario with an unknown command type before invoking the runtime', async () => {
    const setup = fixture({
      'scenario.json': JSON.stringify({
        name: 'bad',
        commands: [{ type: 'bogus' }],
      }),
    });
    const runtime = new FakeRuntime();

    const outcome = await runCli(['node', 'cashu-fault-lab', 'run', 'scenario.json'], {
      runtime,
      io: setup.io,
    });

    expect(outcome.exitCode).toBe(2);
    expect(runtime.runs).toBe(0);
    expect(setup.stderr()).toMatch(/scenario file is invalid/i);
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

  it('diff prints a text summary and exits nonzero when outcomes differ', async () => {
    const passing: ScenarioRunResult = { status: 'passed', artifact };
    const failing: ScenarioRunResult = {
      status: 'failed',
      artifact,
      error: { name: 'Error', message: 'boom' },
    };
    const setup = fixture({
      'left.json': JSON.stringify(passing),
      'right.json': JSON.stringify(failing),
    });

    const outcome = await runCli(['node', 'cashu-fault-lab', 'diff', 'left.json', 'right.json'], {
      io: setup.io,
    });

    expect(outcome.exitCode).toBe(1);
    expect(setup.stdout()).toContain('diff left.json -> right.json');
    expect(setup.stdout()).toContain('status: passed -> failed');
    expect(setup.stdout()).toContain('outcome: different');
  });

  it('diff --json emits machine-readable output and exits zero for identical outcomes', async () => {
    const passing: ScenarioRunResult = { status: 'passed', artifact };
    const setup = fixture({
      'left.json': JSON.stringify(passing),
      'right.json': JSON.stringify(passing),
    });

    const outcome = await runCli(
      ['node', 'cashu-fault-lab', 'diff', 'left.json', 'right.json', '--json'],
      { io: setup.io },
    );

    expect(outcome.exitCode).toBe(0);
    const diff = JSON.parse(setup.stdout()) as { sameOutcome: boolean };
    expect(diff.sameOutcome).toBe(true);
  });

  it('shrinks a failing artifact and forwards the run limit', async () => {
    const setup = fixture({ 'artifact.json': JSON.stringify(artifact) });
    const runtime = new FakeRuntime();

    const outcome = await runCli(
      ['node', 'cashu-fault-lab', 'shrink', 'artifact.json', '--run-limit', '42'],
      { runtime, io: setup.io },
    );

    expect(outcome.exitCode).toBe(0);
    expect(runtime.shrinks).toBe(1);
    expect(runtime.shrinkRunLimit).toBe(42);
  });

  it('rejects an invalid shrink run limit', async () => {
    const setup = fixture({ 'artifact.json': JSON.stringify(artifact) });

    const outcome = await runCli(
      ['node', 'cashu-fault-lab', 'shrink', 'artifact.json', '--run-limit', '0'],
      { runtime: new FakeRuntime(), io: setup.io },
    );

    expect(outcome.exitCode).toBe(2);
    expect(setup.stderr()).toMatch(/run limit/i);
  });

  it('surfaces a shrink error without crashing the CLI', async () => {
    const setup = fixture({ 'artifact.json': JSON.stringify(artifact) });
    const runtime = new FakeRuntime();
    runtime.shrink = async () => {
      throw new Error('Artifact does not reproduce a failure and cannot be minimized');
    };

    const outcome = await runCli(['node', 'cashu-fault-lab', 'shrink', 'artifact.json'], {
      runtime,
      io: setup.io,
    });

    expect(outcome.exitCode).toBe(0);
    expect(setup.stderr()).toMatch(/cannot be minimized/i);
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

  it('writes a JSON matrix report when --format json is given', async () => {
    const setup = fixture();
    const outcome = await runCli(
      [
        'node',
        'cashu-fault-lab',
        'matrix',
        '--profile',
        'delivery-v1',
        '--format',
        'json',
        '--output',
        'matrix.json',
      ],
      { runtime: new FakeRuntime(), io: setup.io },
    );

    expect(outcome.exitCode).toBe(0);
    const report = JSON.parse(setup.stored.get('matrix.json')!) as {
      profile: string;
      summary: { passed: number; total: number };
    };
    expect(report.profile).toBe('delivery-v1');
    expect(report.summary.passed).toBe(1);
    expect(report.summary.total).toBe(1);
  });

  it('renders a junit matrix report to stdout when --format junit is given', async () => {
    const setup = fixture();
    const outcome = await runCli(['node', 'cashu-fault-lab', 'matrix', '--format', 'junit'], {
      runtime: new FakeRuntime(),
      io: setup.io,
    });

    expect(outcome.exitCode).toBe(0);
    expect(setup.stdout()).toContain('<testsuite');
    expect(setup.stdout()).toContain('fake->fake');
  });

  it('renders an html matrix report to stdout when --format html is given', async () => {
    const setup = fixture();
    const outcome = await runCli(['node', 'cashu-fault-lab', 'matrix', '--format', 'html'], {
      runtime: new FakeRuntime(),
      io: setup.io,
    });

    expect(outcome.exitCode).toBe(0);
    expect(setup.stdout()).toContain('<!doctype html>');
    expect(setup.stdout()).toContain('Compatibility matrix');
  });

  it('loads and passes a versioned adapter manifest to run and matrix commands', async () => {
    const manifest = {
      schemaVersion: 1,
      adapters: [{ id: 'cdk', url: 'http://127.0.0.1:4102', tokenEnv: 'CFL_CDK_TOKEN' }],
    } as const;
    const scenario: ScenarioSpec = {
      name: 'request-loss',
      commands: [{ type: 'assert_quiescent' }],
    };
    const setup = fixture({
      'scenario.json': JSON.stringify(scenario),
      'adapters.json': JSON.stringify(manifest),
    });
    const runtime = new FakeRuntime();

    await runCli(
      [
        'node',
        'cashu-fault-lab',
        'run',
        'scenario.json',
        '--adapters',
        'adapters.json',
        '--sender',
        'cdk',
        '--receiver',
        'cdk',
      ],
      { runtime, io: setup.io },
    );
    expect(runtime.adapterManifest).toEqual(manifest);

    await runCli(['node', 'cashu-fault-lab', 'matrix', '--adapters', 'adapters.json'], {
      runtime,
      io: setup.io,
    });
    expect(runtime.adapterManifest).toEqual(manifest);
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

  it('doctor prints checks and exits nonzero when a required env var is missing', async () => {
    const setup = fixture();
    const probes: DoctorProbes = {
      env: {},
      execFile: async () => ({ stdout: '', stderr: '' }),
      isPortFree: async () => true,
    };

    const outcome = await runCli(['node', 'cashu-fault-lab', 'doctor'], {
      io: setup.io,
      doctorProbes: probes,
    });

    expect(outcome.exitCode).toBe(1);
    expect(setup.stdout()).toMatch(/CFL_CASHU_TS_TOKEN: missing/);
    expect(setup.stdout()).toMatch(/doctor:/);
  });

  it('doctor --json emits a machine-readable report', async () => {
    const setup = fixture();
    const probes: DoctorProbes = {
      env: {
        CFL_CASHU_TS_TOKEN: 'lab-only-cashu-ts-token',
        CFL_CDK_TOKEN: 'lab-only-cdk-token',
        CFL_REFERENCE_RECEIVER_TOKEN: 'lab-only-receiver-token',
        CFL_REFERENCE_RECEIVER_CLAIM_KEY: 'ERERERERERERERERERERERERERERERERERERERERERE',
        CFL_HTTP_FAULT_GATEWAY_TOKEN: 'lab-only-fault-token',
      },
      execFile: async (command) => {
        const table: Readonly<Record<string, string>> = {
          node: 'v24.0.0',
          pnpm: '11.15.0',
          docker: 'Docker version 27.0.0, build abc',
          cargo: 'cargo 1.97.0 (abc)',
        };
        return { stdout: `${table[command] ?? ''}\n`, stderr: '' };
      },
      isPortFree: async () => true,
    };

    const outcome = await runCli(['node', 'cashu-fault-lab', 'doctor', '--json'], {
      io: setup.io,
      doctorProbes: probes,
    });

    expect(outcome.exitCode).toBe(0);
    const report = JSON.parse(setup.stdout()) as { ok: boolean; checks: { name: string }[] };
    expect(report.ok).toBe(true);
    expect(report.checks.some((c) => c.name === 'node')).toBe(true);
  });
});
