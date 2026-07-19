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
      runner.replay({ ...first.artifact, schemaVersion: 2 } as unknown as typeof first.artifact),
    ).rejects.toThrowError(/schema version/i);
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
});
