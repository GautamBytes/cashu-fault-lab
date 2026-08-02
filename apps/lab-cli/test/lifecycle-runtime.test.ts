import type {
  LifecycleAdapterClient,
  LifecycleCapabilities,
  LifecycleOperationInput,
  LifecycleOperationView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import { describe, expect, it } from 'vitest';
import {
  createEnvironmentLifecycleRuntime,
  HttpLifecycleLabRuntime,
} from '../src/lifecycle-runtime.js';
import type {
  LifecycleFaultRule,
  LifecycleScenarioSpec,
} from '@cashu-fault-lab/wallet-lifecycle-runner';

const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
const mint = 'http://127.0.0.1:3338';
const requestHash = 'b'.repeat(64);
const outputPlanHash = 'c'.repeat(64);

class FakeClient implements LifecycleAdapterClient {
  input: LifecycleOperationInput | undefined;

  async capabilities(): Promise<LifecycleCapabilities> {
    return {
      schemaVersion: 1,
      implementation: {
        id: 'cashu-ts',
        version: '1.0.0',
        language: 'typescript',
        runtime: 'node-24',
        sourceDigest: `sha256:${'a1'.repeat(32)}`,
        buildDigest: `sha256:${'b2'.repeat(32)}`,
      },
      operations: ['mint'],
      nuts: [4, 7, 9, 19],
      durability: 'restart_safe',
      recovery: ['quote_state', 'proof_state', 'nut09_restore', 'nut19_replay'],
      mints: [{ id: 'nutshell-local', implementation: 'nutshell' }],
    };
  }

  async reset(): Promise<void> {}

  async start(input: LifecycleOperationInput): Promise<LifecycleOperationView> {
    this.input = input;
    return {
      operationId,
      kind: 'mint',
      mint,
      unit: 'sat',
      intentHash: 'a'.repeat(64),
      phase: 'ambiguous',
      amount: 8,
      requestHash,
      outputPlanHash,
    };
  }

  async resume(): Promise<LifecycleOperationView> {
    return {
      operationId,
      kind: 'mint',
      mint,
      unit: 'sat',
      intentHash: 'a'.repeat(64),
      phase: 'succeeded',
      amount: 8,
      requestHash,
      outputPlanHash,
    };
  }

  operation(): Promise<LifecycleOperationView> {
    throw new Error('not used');
  }

  wallet() {
    return Promise.resolve({
      walletId: 'cashu-ts',
      mint,
      unit: 'sat',
      balances: { available: 8, reserved: 0, recoverable: 0 },
      proofs: [],
    });
  }

  evidence() {
    return Promise.resolve([]);
  }
}

describe('HTTP lifecycle lab runtime', () => {
  it('configures packaged restart scenarios with a compose restart controller', () => {
    const runtime = createEnvironmentLifecycleRuntime({});

    expect(runtime.options.restartController).toEqual(expect.any(Function));
  });

  it('maps semantic faults and normalizes an ambiguous recovery into oracle observations', async () => {
    const client = new FakeClient();
    const faults: Array<LifecycleFaultRule | undefined> = [];
    const faultRule: LifecycleFaultRule = {
      action: 'drop_response',
      endpoint: 'mint',
      occurrence: 1,
    };
    const runtime = new HttpLifecycleLabRuntime({
      adapter: async () => ({ client, componentVersion: '1.0.0' }),
      faultController: {
        configure: async (rule) => {
          faults.push(rule);
        },
      },
    });
    const scenario: LifecycleScenarioSpec = {
      id: 'mint-response-lost',
      seed: 'seed-42',
      requireQuiescence: true,
      commands: [
        { type: 'fault', rule: faultRule },
        {
          type: 'start',
          input: { operationId, kind: 'mint', mint, unit: 'sat', amount: 8, method: 'bolt11' },
        },
        { type: 'clear_faults' },
        { type: 'resume', operationId },
      ],
    };

    const execution = await runtime.run({
      scenario,
      seed: scenario.seed,
      adapterId: 'cashu-ts',
      mintId: 'nutshell-local',
    });

    expect(execution.result.ok).toBe(true);
    expect(faults).toEqual([undefined, faultRule, undefined]);
    if (!execution.result.ok) throw new Error('scenario unexpectedly failed');
    expect(execution.result.model.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'request_dispatched', bodyHash: requestHash }),
        expect.objectContaining({ type: 'outputs_persisted', outputPlanHash }),
        expect.objectContaining({ type: 'phase_observed', phase: 'succeeded' }),
      ]),
    );
  });
});
