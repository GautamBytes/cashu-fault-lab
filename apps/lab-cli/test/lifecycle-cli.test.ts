import {
  lifecycleSeedHash,
  type LifecycleFailureArtifact,
  type LifecycleHistoryEntry,
  type LifecycleScenarioSpec,
} from '@cashu-fault-lab/wallet-lifecycle-runner';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LifecycleLabRuntime } from '../src/commands/lifecycle.js';
import { runCli, type CliIo } from '../src/index.js';

const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
const scenario: LifecycleScenarioSpec & {
  readonly schemaVersion: 1;
  readonly requiredOperations: readonly ['mint'];
} = {
  schemaVersion: 1,
  id: 'mint-response-lost',
  seed: 'packaged-seed',
  requiredOperations: ['mint'],
  requireQuiescence: true,
  commands: [
    {
      type: 'start',
      input: {
        operationId,
        kind: 'mint',
        mint: 'http://127.0.0.1:3338',
        unit: 'sat',
        amount: 8,
        method: 'bolt11',
      },
    },
  ],
};

function fixture(files: Readonly<Record<string, string>> = {}) {
  const stored = new Map(Object.entries(files));
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    readText: async (path) => {
      const value =
        stored.get(path) ?? stored.get(relative(process.cwd(), path).replaceAll('\\', '/'));
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

class FakeLifecycleRuntime implements LifecycleLabRuntime {
  runs: Array<{ readonly scenario: LifecycleScenarioSpec; readonly seed: string }> = [];
  replayed: LifecycleFailureArtifact[] = [];

  async run(input: {
    readonly scenario: LifecycleScenarioSpec;
    readonly seed: string;
    readonly adapterId: string;
    readonly mintId: string;
  }): Promise<{
    readonly result: {
      readonly ok: true;
      readonly model: { readonly observations: readonly [] };
      readonly history: readonly LifecycleHistoryEntry[];
    };
  }> {
    this.runs.push({ scenario: input.scenario, seed: input.seed });
    return { result: { ok: true, model: { observations: [] }, history: [] } };
  }

  async matrix() {
    return [
      {
        id: 'cdk-nutshell',
        implementationId: 'cdk',
        mintId: 'nutshell-local',
        status: 'not_applicable' as const,
        reason: 'melt requires an independent Lightning settlement probe',
      },
    ];
  }

  async replay(input: { readonly artifact: LifecycleFailureArtifact }) {
    this.replayed.push(input.artifact);
    return { matched: true as const };
  }
}

describe('wallet lifecycle CLI', () => {
  it('runs a validated scenario with an explicit deterministic seed and writes a redacted report', async () => {
    const setup = fixture({
      'scenarios/wallet-lifecycle/mint-response-lost.json': JSON.stringify(scenario),
    });
    const runtime = new FakeLifecycleRuntime();
    const outcome = await runCli(
      [
        'node',
        'cashu-fault-lab',
        'lifecycle',
        'run',
        'mint-response-lost',
        '--adapter',
        'cashu-ts',
        '--mint',
        'nutshell-local',
        '--seed',
        '42',
        '--artifact',
        'artifacts/lifecycle.json',
      ],
      { io: setup.io, lifecycleRuntime: runtime },
    );

    expect(outcome.exitCode, setup.stderr()).toBe(0);
    expect(runtime.runs).toHaveLength(1);
    expect(runtime.runs[0]?.seed).toBe('42');
    expect(setup.stdout()).toContain('passed mint-response-lost seedHash=');
    const report = setup.stored.get('artifacts/lifecycle.json') ?? '';
    expect(report).toContain(lifecycleSeedHash('42'));
    expect(report).not.toContain('"seed": "42"');
  });

  it('reports unsupported matrix lanes as N/A without turning them into passes', async () => {
    const setup = fixture();
    const outcome = await runCli(
      ['node', 'cashu-fault-lab', 'lifecycle', 'matrix', '--profile', 'wallet-lifecycle-v1'],
      { io: setup.io, lifecycleRuntime: new FakeLifecycleRuntime() },
    );

    expect(outcome.exitCode).toBe(0);
    expect(setup.stdout()).toContain('N/A');
    expect(setup.stdout()).toContain('0 passed');
  });

  it('replays a lifecycle failure with an out-of-band seed', async () => {
    const seed = 'replay-seed';
    const artifact: LifecycleFailureArtifact = {
      schemaVersion: 2,
      scenario: {
        id: scenario.id,
        seedHash: lifecycleSeedHash(seed),
        requireQuiescence: true,
        commands: scenario.commands,
      },
      redacted: false,
      history: [],
      observations: [],
      failure: { commandIndex: 0, code: 'LIFECYCLE_INVARIANT', message: 'invariant failed' },
    };
    const setup = fixture({ 'artifacts/failure.json': JSON.stringify(artifact) });
    const runtime = new FakeLifecycleRuntime();
    const outcome = await runCli(
      [
        'node',
        'cashu-fault-lab',
        'lifecycle',
        'replay',
        'artifacts/failure.json',
        '--seed',
        seed,
        '--adapter',
        'cashu-ts',
        '--mint',
        'nutshell-local',
      ],
      { io: setup.io, lifecycleRuntime: runtime },
    );

    expect(outcome.exitCode).toBe(0);
    expect(runtime.replayed).toEqual([artifact]);
    expect(setup.stdout()).toContain('matched mint-response-lost');
  });

  it('rejects replay commands outside the lifecycle schema', async () => {
    const seed = 'replay-seed';
    const setup = fixture({
      'artifacts/forged.json': JSON.stringify({
        schemaVersion: 2,
        scenario: {
          id: scenario.id,
          seedHash: lifecycleSeedHash(seed),
          requireQuiescence: true,
          commands: [{ type: 'restart', component: 'host', injected: true }],
        },
        redacted: false,
        history: [],
        observations: [],
        failure: { commandIndex: 0, code: 'LIFECYCLE_DRIVER', message: 'failed' },
      }),
    });
    const outcome = await runCli(
      [
        'node',
        'cashu-fault-lab',
        'lifecycle',
        'replay',
        'artifacts/forged.json',
        '--seed',
        seed,
        '--adapter',
        'cashu-ts',
        '--mint',
        'nutshell-local',
      ],
      { io: setup.io, lifecycleRuntime: new FakeLifecycleRuntime() },
    );

    expect(outcome.exitCode).toBe(2);
    expect(setup.stderr()).toContain('commands are invalid');
  });
});
