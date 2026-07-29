import {
  unobservableInvariantResults,
  type FailureArtifact,
  type MatrixCaseResult,
  type ScenarioRunResult,
  type ScenarioSpec,
} from '@cashu-fault-lab/scenario-runner';
import type { AdapterCapabilities } from '@cashu-fault-lab/adapter-contract';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdapterManifest } from '../src/adapter-manifest.js';
import type { DoctorProbes } from '../src/doctor.js';
import type { LoadedReleaseSuite } from '../src/release-suite-loader.js';
import {
  runCli,
  type CliIo,
  type LabDemoOptions,
  type LabDemoResult,
  type LabRuntime,
} from '../src/index.js';

const artifact: FailureArtifact = {
  schemaVersion: 2,
  seed: 'seed-1',
  scenario: 'request-loss',
  commands: [{ type: 'assert_quiescent' }],
  history: [],
  capabilities: { implementation: 'fake', version: '1.0.0' },
  invariants: unobservableInvariantResults('Test fixture has no invariant evidence.'),
};
const passed: ScenarioRunResult = { status: 'passed', artifact };
const matrixCapability: AdapterCapabilities = {
  schemaVersion: 2,
  implementation: {
    id: 'fake',
    version: '1.0.0',
    language: 'typescript',
    runtime: 'node-24',
    sourceDigest: `sha256:${'ab'.repeat(32)}`,
    buildDigest: `sha256:${'cd'.repeat(32)}`,
  },
  roles: {
    sender: {
      transports: ['http'],
      profiles: ['delivery-v1'],
      durability: 'process',
      evidence: { tier: 'T0', sources: ['adapter'] },
    },
    receiver: {
      transports: ['http'],
      profiles: ['delivery-v1'],
      durability: 'process',
      evidence: { tier: 'T0', sources: ['adapter'] },
    },
  },
  nuts: [18],
  encodings: ['creqA'],
  mints: [{ id: 'test-mint', implementation: 'test-mint' }],
};
const gateInvariant = {
  id: 'independent-ledger-evidence',
  status: 'passed',
  confidence: 'observed',
  evidence: [{ source: 'ledger', description: 'Test ledger evidence.' }],
} as const;

class FakeRuntime implements LabRuntime {
  runs = 0;
  replays = 0;
  shrinks = 0;
  shrinkRunLimit: number | undefined;
  selection: { sender: string; receiver: string } | undefined;
  adapterManifest: AdapterManifest | undefined;
  matrices = 0;
  upProfiles: string[] = [];
  downProfiles: string[] = [];
  demos = 0;
  demoOptions: LabDemoOptions | undefined;
  demoResult: LabDemoResult | undefined;

  async up(profile: string): Promise<void> {
    this.upProfiles.push(profile);
  }

  async down(profile: string): Promise<void> {
    this.downProfiles.push(profile);
  }

  async demo(options: LabDemoOptions): Promise<LabDemoResult> {
    this.demos += 1;
    this.demoOptions = options;
    return (
      this.demoResult ?? {
        status: 'passed',
        result: passed,
        envFile: '.cashu-fault-lab/runtime/reference/secrets.env',
        artifactPath:
          options.artifactPath ?? '.cashu-fault-lab/runtime/reference/reports/demo.json',
        reportPath: options.reportPath ?? '.cashu-fault-lab/runtime/reference/reports/demo.html',
        startedStack: true,
        keptStack: options.keep ?? false,
      }
    );
  }

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
    releaseSuite?: LoadedReleaseSuite,
  ): Promise<readonly MatrixCaseResult[]> {
    this.matrices += 1;
    this.adapterManifest = adapterManifest;
    return [
      {
        profile: 'delivery-v1',
        sender: 'fake',
        receiver: 'fake',
        status: 'passed',
        senderCapabilities: matrixCapability,
        receiverCapabilities: matrixCapability,
        invariants: [gateInvariant],
        mints: [{ id: 'test-mint', implementation: 'test-mint' }],
        ...(releaseSuite === undefined ? {} : { releaseSuiteDigest: releaseSuite.digest }),
        scenarios:
          releaseSuite?.scenarios.map(({ id, requiredInvariants }) => ({
            id,
            seed: `suite-${id}`,
            status: 'passed' as const,
            requiredInvariants,
            invariants: [gateInvariant],
          })) ?? [],
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
      const value =
        stored.get(path) ?? stored.get(relative(process.cwd(), path).split('\\').join('/'));
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    realPath: async (path) => path,
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
  const releaseSuiteDigest =
    'sha256:469e14369679643e4243e78888f5451eddb47603a1a9fa7fdd0729d0037ada7c';
  const releaseSuiteFiles = {
    'spec/release-suite.json': JSON.stringify({
      schemaVersion: 1,
      profile: 'delivery-v1',
      scenarios: [
        {
          id: 'test-scenario',
          scenario: 'scenarios/test-scenario.json',
          transports: ['http'],
          senderDurability: 'process',
          receiverDurability: 'process',
          requiredInvariants: ['independent-ledger-evidence'],
        },
      ],
    }),
    'scenarios/test-scenario.json': JSON.stringify({
      name: 'test-scenario',
      commands: [{ type: 'assert_quiescent' }],
    }),
  };

  it('prints its version with a successful exit code', async () => {
    const setup = fixture();
    const outcome = await runCli(['node', 'cashu-fault-lab', '--version'], {
      io: setup.io,
      runtime: new FakeRuntime(),
    });

    expect(outcome.exitCode).toBe(0);
    expect(setup.stdout().trim()).toBe('0.1.0');
  });

  it('scaffolds an adapter project through adapter init', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cashu-cli-adapter-init-'));
    const output = join(directory, 'my-wallet');

    try {
      const setup = fixture();
      const outcome = await runCli(
        [
          'node',
          'cashu-fault-lab',
          'adapter',
          'init',
          '--language',
          'python',
          '--name',
          'my-wallet',
          '--output',
          output,
        ],
        { io: setup.io, runtime: new FakeRuntime() },
      );

      expect(outcome.exitCode).toBe(0);
      expect(setup.stdout()).toContain(output);
      expect(await readFile(join(output, 'adapter-manifest.json'), 'utf8')).toContain(
        'MY_WALLET_TOKEN',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it('checks startup prerequisites before starting the lab without requiring manual secrets', async () => {
    const setup = fixture();
    const runtime = new FakeRuntime();
    const probes: DoctorProbes = {
      env: {},
      execFile: async (command, args) => {
        if (command === 'node') return { stdout: 'v24.0.0\n', stderr: '' };
        if (command === 'pnpm') return { stdout: '11.15.0\n', stderr: '' };
        if (command === 'docker' && args[0] === '--version') {
          return { stdout: 'Docker version 27.0.0, build abc\n', stderr: '' };
        }
        if (command === 'docker' && args[0] === 'info') return { stdout: '27.0.0\n', stderr: '' };
        throw new Error(`unexpected probe ${command} ${args.join(' ')}`);
      },
      isPortFree: async () => true,
    };

    const outcome = await runCli(['node', 'cashu-fault-lab', 'up'], {
      runtime,
      io: setup.io,
      doctorProbes: probes,
    });

    expect(outcome.exitCode).toBe(0);
    expect(runtime.upProfiles).toEqual(['lab']);
    expect(setup.stdout()).toContain('started lab');
  });

  it('reports an actionable diagnostic when lab up cannot bind a conflicted port', async () => {
    const setup = fixture();
    const runtime = new FakeRuntime();
    runtime.up = async (profile: string) => {
      runtime.upProfiles.push(profile);
      throw new Error('bind: address already in use');
    };
    const probes: DoctorProbes = {
      env: {},
      execFile: async (command, args) => {
        if (command === 'node') return { stdout: 'v24.0.0\n', stderr: '' };
        if (command === 'pnpm') return { stdout: '11.15.0\n', stderr: '' };
        if (command === 'docker' && args[0] === '--version') {
          return { stdout: 'Docker version 27.0.0, build abc\n', stderr: '' };
        }
        if (command === 'docker' && args[0] === 'info') return { stdout: '27.0.0\n', stderr: '' };
        throw new Error(`unexpected probe ${command} ${args.join(' ')}`);
      },
      isPortFree: async (_host, port) => port !== 4101,
    };

    const outcome = await runCli(['node', 'cashu-fault-lab', 'up'], {
      runtime,
      io: setup.io,
      doctorProbes: probes,
    });

    expect(outcome.exitCode).toBe(2);
    expect(runtime.upProfiles).toEqual(['lab']);
    expect(setup.stderr()).toContain('PORT_IN_USE');
    expect(setup.stderr()).toContain('cashu-fault-lab down --profile lab');
  });

  it('runs the packaged demo and prints the generated report location', async () => {
    const setup = fixture();
    const runtime = new FakeRuntime();

    const outcome = await runCli(
      [
        'node',
        'cashu-fault-lab',
        'demo',
        '--keep',
        '--seed',
        'demo-seed',
        '--artifact',
        'demo/evidence.json',
        '--report',
        'demo/report.html',
      ],
      { runtime, io: setup.io },
    );

    expect(outcome.exitCode).toBe(0);
    expect(runtime.demos).toBe(1);
    expect(runtime.demoOptions).toEqual({
      keep: true,
      seed: 'demo-seed',
      artifactPath: 'demo/evidence.json',
      reportPath: 'demo/report.html',
    });
    expect(setup.stdout()).toContain('demo/report.html');
    expect(setup.stdout()).toContain('passed');
  });

  it('prints runtime-redacted demo failure messages', async () => {
    const setup = fixture();
    const runtime = new FakeRuntime();
    runtime.demoResult = {
      status: 'failed',
      result: {
        status: 'failed',
        artifact,
        error: { name: 'Error', message: 'demo failed with [REDACTED]' },
      },
      envFile: '.cashu-fault-lab/runtime/reference/secrets.env',
      artifactPath: 'demo/evidence.json',
      reportPath: 'demo/report.html',
      startedStack: true,
      keptStack: false,
    };

    const outcome = await runCli(['node', 'cashu-fault-lab', 'demo'], {
      runtime,
      io: setup.io,
    });

    expect(outcome.exitCode).toBe(1);
    expect(setup.stderr()).toContain('[REDACTED]');
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

  it('rejects a malformed release policy before starting the matrix', async () => {
    const setup = fixture({ 'bad-policy.json': JSON.stringify({ schemaVersion: 99 }) });
    const runtime = new FakeRuntime();

    const outcome = await runCli(
      ['node', 'cashu-fault-lab', 'matrix', '--release-policy', 'bad-policy.json'],
      { runtime, io: setup.io },
    );

    expect(outcome.exitCode).toBe(2);
    expect(runtime.matrices).toBe(0);
    expect(setup.stderr()).toMatch(/release policy/i);
  });

  it('evaluates a release policy and prints every rejection reason', async () => {
    const selectedPolicy = {
      schemaVersion: 3,
      releaseSuiteDigest,
      profile: 'delivery-v1',
      minimumQualifyingPairs: 2,
      requireCrossImplementation: true,
      requireCrossLanguage: true,
      requireDistinctBuilds: true,
      minimumDistinctMints: 2,
      minimumEvidence: { sender: 'T1', receiver: 'T3' },
      requiredInvariants: ['independent-ledger-evidence'],
      requiredScenarios: ['test-scenario'],
      acceptedConfidence: ['observed', 'derived'],
    };
    const setup = fixture({
      'policy.json': JSON.stringify(selectedPolicy),
      ...releaseSuiteFiles,
    });
    const runtime = new FakeRuntime();
    const baseMatrix = runtime.matrix.bind(runtime);
    runtime.matrix = async (...args) =>
      (await baseMatrix(...args)).map((result) =>
        result.status === 'passed' ? { ...result, mints: [] } : result,
      );

    const outcome = await runCli(
      ['node', 'cashu-fault-lab', 'matrix', '--release-policy', 'policy.json'],
      { runtime, io: setup.io },
    );

    expect(outcome.exitCode).toBe(1);
    expect(setup.stderr()).toContain('CROSS_IMPLEMENTATION_REQUIRED');
    expect(setup.stderr()).toContain('CROSS_LANGUAGE_REQUIRED');
    expect(setup.stderr()).toContain('SENDER_EVIDENCE_TOO_LOW');
    expect(setup.stderr()).toContain('RECEIVER_EVIDENCE_TOO_LOW');
    expect(setup.stderr()).toContain('MINT_IDENTITY_REQUIRED');
    expect(setup.stderr()).toContain('MINIMUM_QUALIFYING_PAIRS');
    expect(setup.stderr()).toContain('MINIMUM_DISTINCT_MINTS');
  });

  it('exits zero for a satisfied release policy', async () => {
    const selectedPolicy = {
      schemaVersion: 3,
      releaseSuiteDigest,
      profile: 'delivery-v1',
      minimumQualifyingPairs: 1,
      requireCrossImplementation: false,
      requireCrossLanguage: false,
      requireDistinctBuilds: false,
      minimumDistinctMints: 0,
      minimumEvidence: { sender: 'T0', receiver: 'T0' },
      requiredInvariants: ['independent-ledger-evidence'],
      requiredScenarios: ['test-scenario'],
      acceptedConfidence: ['observed'],
    };
    const setup = fixture({
      'policy.json': JSON.stringify(selectedPolicy),
      ...releaseSuiteFiles,
    });

    const outcome = await runCli(
      ['node', 'cashu-fault-lab', 'matrix', '--release-policy', 'policy.json'],
      { runtime: new FakeRuntime(), io: setup.io },
    );

    expect(outcome.exitCode).toBe(0);
    expect(setup.stdout()).toContain('release gate: passed');
  });

  it('rejects a release suite digest mismatch before starting the matrix', async () => {
    const selectedPolicy = {
      schemaVersion: 3,
      releaseSuiteDigest: `sha256:${'00'.repeat(32)}`,
      profile: 'delivery-v1',
      minimumQualifyingPairs: 1,
      requireCrossImplementation: false,
      requireCrossLanguage: false,
      requireDistinctBuilds: false,
      minimumDistinctMints: 0,
      minimumEvidence: { sender: 'T0', receiver: 'T0' },
      requiredInvariants: ['independent-ledger-evidence'],
      requiredScenarios: ['test-scenario'],
      acceptedConfidence: ['observed'],
    };
    const setup = fixture({
      'policy.json': JSON.stringify(selectedPolicy),
      ...releaseSuiteFiles,
    });
    const runtime = new FakeRuntime();

    const outcome = await runCli(
      ['node', 'cashu-fault-lab', 'matrix', '--release-policy', 'policy.json'],
      { runtime, io: setup.io },
    );

    expect(outcome.exitCode).toBe(2);
    expect(runtime.matrices).toBe(0);
    expect(setup.stderr()).toMatch(/release suite digest .* does not match policy/i);
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
    expect(setup.stderr()).toContain('Error: failed');
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
        CFL_REAL_MINT_URL: 'http://127.0.0.1:3338',
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
    expect(report.checks.some((c) => c.name === 'testcontainers')).toBe(true);
  });

  it('checks only end-user runtime prerequisites in the npm distribution', async () => {
    const setup = fixture();
    const commands: string[] = [];
    const probes: DoctorProbes = {
      env: {},
      execFile: async (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        if (command === 'node') return { stdout: 'v24.0.0\n', stderr: '' };
        if (command === 'docker' && args[0] === '--version') {
          return { stdout: 'Docker version 27.0.0, build abc\n', stderr: '' };
        }
        if (command === 'docker' && args[0] === 'info') {
          return { stdout: '27.0.0\n', stderr: '' };
        }
        if (command === 'docker' && args.join(' ') === 'compose version --short') {
          return { stdout: '2.40.0\n', stderr: '' };
        }
        throw new Error(`unexpected probe ${command} ${args.join(' ')}`);
      },
      isPortFree: async () => true,
    };

    const outcome = await runCli(['node', 'cashu-fault-lab', 'doctor', '--json'], {
      distribution: 'package',
      io: setup.io,
      doctorProbes: probes,
    });

    expect(outcome.exitCode).toBe(0);
    const report = JSON.parse(setup.stdout()) as { ok: boolean; checks: { name: string }[] };
    expect(report.ok).toBe(true);
    expect(report.checks.map(({ name }) => name)).not.toContain('pnpm');
    expect(report.checks.map(({ name }) => name)).not.toContain('cargo (CDK adapter)');
    expect(report.checks.map(({ name }) => name)).not.toContain('testcontainers');
    expect(report.checks).toContainEqual({
      name: 'docker compose',
      status: 'ok',
      detail: '2.40.0',
    });
    expect(report.checks.some(({ name }) => name.startsWith('CFL_'))).toBe(false);
    expect(commands.some((command) => command.startsWith('pnpm '))).toBe(false);
    expect(commands.some((command) => command.startsWith('cargo '))).toBe(false);
  });

  it('emits a machine-readable diagnostic for command errors when global --json is set', async () => {
    const scenario: ScenarioSpec = {
      name: 'request-loss',
      commands: [{ type: 'assert_quiescent' }],
    };
    const setup = fixture({
      'scenario.json': JSON.stringify(scenario),
      'bad-adapters.json': JSON.stringify({ schemaVersion: 1, adapters: [] }),
    });
    const runtime = new FakeRuntime();

    const outcome = await runCli(
      [
        'node',
        'cashu-fault-lab',
        '--json',
        'run',
        'scenario.json',
        '--adapters',
        'bad-adapters.json',
      ],
      { runtime, io: setup.io },
    );

    expect(outcome.exitCode).toBe(2);
    expect(runtime.runs).toBe(0);
    expect(JSON.parse(setup.stderr())).toMatchObject({
      code: 'ADAPTER_MANIFEST_INVALID',
      problem: expect.stringContaining('Adapter manifest'),
      likelyCause: expect.any(String),
      remediation: expect.any(String),
      nextCommand: expect.stringContaining('cashu-fault-lab doctor'),
    });
  });
});
