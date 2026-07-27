import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  minimizeFailingCommands,
  ScenarioRunner,
  type DriverSendResult,
  type FaultRule,
  type ScenarioDriver,
  type ScenarioSpec,
} from '../src/index.js';

class ReplayDriver implements ScenarioDriver {
  async reset(_seed: string): Promise<void> {}
  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    return { replay: true };
  }
  async configureFault(_target: string, _rule: FaultRule): Promise<void> {}
  async send(_sender: string, requestId: string): Promise<DriverSendResult> {
    return {
      value: { ok: true },
      observations: [
        { type: 'request_observed', requestId, singleUse: false },
        {
          type: 'delivery_attempted',
          requestId,
          deliveryId: 'delivery-1',
          payloadHash: 'payload-a',
          proofSetHash: 'proofs-a',
          transport: 'http',
        },
        { type: 'mint_proofs_state', proofSetHash: 'proofs-a', state: 'UNSPENT' },
        {
          type: 'receipt_observed',
          requestId,
          deliveryId: 'delivery-1',
          payloadHash: 'payload-a',
          status: 'rejected',
          detailCode: 'invalid',
          version: 1,
          amount: 8,
          unit: 'sat',
        },
      ],
    };
  }
  async restart(_component: string): Promise<void> {}
  async clearFaults(_target?: string): Promise<void> {}
}

const scenario: ScenarioSpec = {
  name: 'replayable',
  commands: [
    { type: 'send', sender: 'sender-a', requestId: 'request-1' },
    { type: 'assert_quiescent' },
  ],
};

describe('scenario replay', () => {
  it('replays a JSON-round-tripped artifact exactly', async () => {
    const runner = new ScenarioRunner(new ReplayDriver());
    const first = await runner.run(scenario, 'seed-replay');
    const artifact = JSON.parse(JSON.stringify(first.artifact));
    expect(await runner.replay(artifact)).toEqual(first);
  });

  it('rejects unsupported artifact versions', async () => {
    const runner = new ScenarioRunner(new ReplayDriver());
    const first = await runner.run(scenario, 'seed-replay');
    await expect(
      runner.replay({ ...first.artifact, schemaVersion: 1 } as unknown as typeof first.artifact),
    ).rejects.toThrowError(/schema version/i);
  });

  it('rejects recorded invariant evidence that does not reproduce', async () => {
    const runner = new ScenarioRunner(new ReplayDriver());
    const first = await runner.run(scenario, 'seed-replay');
    const [invariant, ...rest] = first.artifact.invariants;
    if (invariant === undefined) throw new Error('Expected invariant evidence');
    const artifact = {
      ...first.artifact,
      invariants: [{ ...invariant, status: 'failed' as const }, ...rest],
    };

    await expect(runner.replay(artifact)).rejects.toThrowError(/invariant evidence/i);
  });

  it('contains no wall-clock scheduling APIs', () => {
    for (const name of ['scheduler.ts', 'runner.ts', 'replay.ts']) {
      const path = fileURLToPath(new URL(`../src/${name}`, import.meta.url));
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/Date\.now|setTimeout|setInterval/);
    }
  });

  it('deterministically removes commands irrelevant to a failure', async () => {
    const commands: ScenarioSpec['commands'] = [
      { type: 'advance_time', milliseconds: 1 },
      { type: 'send', sender: 'sender-a', requestId: 'request-1' },
      { type: 'clear_faults' },
    ];
    const minimized = await minimizeFailingCommands(
      commands,
      async (candidate) => candidate.some((command) => command.type === 'send'),
      20,
    );
    expect(minimized).toEqual([{ type: 'send', sender: 'sender-a', requestId: 'request-1' }]);
  });

  it('does not evaluate shrink candidates that break start/await dependencies', async () => {
    const commands: ScenarioSpec['commands'] = [
      { type: 'start_send', operationId: 'op-1', sender: 'sender-a', requestId: 'request-1' },
      { type: 'advance_time', milliseconds: 250 },
      { type: 'await_send', operationId: 'op-1' },
    ];
    let invalidCandidateEvaluated = false;

    const minimized = await minimizeFailingCommands(
      commands,
      async (candidate) => {
        const hasStart = candidate.some(
          (command) => command.type === 'start_send' && command.operationId === 'op-1',
        );
        const hasAwait = candidate.some(
          (command) => command.type === 'await_send' && command.operationId === 'op-1',
        );
        if (hasStart !== hasAwait) invalidCandidateEvaluated = true;
        return hasStart && hasAwait;
      },
      20,
    );

    expect(invalidCandidateEvaluated).toBe(false);
    expect(minimized).toEqual([
      { type: 'start_send', operationId: 'op-1', sender: 'sender-a', requestId: 'request-1' },
      { type: 'await_send', operationId: 'op-1' },
    ]);
  });

  it('minimizes virtual-time command values while preserving the failure', async () => {
    const commands: ScenarioSpec['commands'] = [
      { type: 'start_send', operationId: 'op-1', sender: 'sender-a', requestId: 'request-1' },
      { type: 'advance_time', milliseconds: 1_000 },
      { type: 'await_send', operationId: 'op-1' },
    ];

    const minimized = await minimizeFailingCommands(
      commands,
      async (candidate) => {
        const hasStart = candidate.some((command) => command.type === 'start_send');
        const hasAwait = candidate.some((command) => command.type === 'await_send');
        const advanced = candidate.reduce(
          (sum, command) => (command.type === 'advance_time' ? sum + command.milliseconds : sum),
          0,
        );
        return hasStart && hasAwait && advanced >= 250;
      },
      40,
    );

    expect(minimized).toEqual([
      { type: 'start_send', operationId: 'op-1', sender: 'sender-a', requestId: 'request-1' },
      { type: 'advance_time', milliseconds: 250 },
      { type: 'await_send', operationId: 'op-1' },
    ]);
  });
});
