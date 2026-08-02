import { createOperation } from '@cashu-fault-lab/wallet-lifecycle-core';
import { describe, expect, test } from 'vitest';
import {
  LifecycleScenarioRunner,
  type LifecycleDriver,
  type LifecycleDriverStep,
  type LifecycleFaultRule,
  type LifecycleScenarioSpec,
} from '../src/index.js';

const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
const mint = 'http://127.0.0.1:3338';
const requestHash = 'b'.repeat(64);
const operation = createOperation({
  operationId,
  kind: 'mint',
  mint,
  unit: 'sat',
  intentHash: 'a'.repeat(64),
});

class MintRecoveryDriver implements LifecycleDriver {
  readonly requests: string[] = [];
  fault: LifecycleFaultRule | undefined;

  constructor(readonly mutateReplay = false) {}

  async reset(): Promise<void> {
    this.requests.length = 0;
    this.fault = undefined;
  }

  async configureFault(rule: LifecycleFaultRule | undefined): Promise<void> {
    this.fault = rule;
  }

  async start(): Promise<LifecycleDriverStep> {
    this.requests.push(requestHash);
    return {
      observations: [
        { type: 'operation_observed', operation },
        { type: 'phase_observed', operationId, phase: 'prepared' },
        {
          type: 'request_dispatched',
          operationId,
          requestKind: 'mint',
          method: 'POST',
          path: '/v1/mint/bolt11',
          bodyHash: requestHash,
        },
        { type: 'phase_observed', operationId, phase: 'submitted' },
        { type: 'phase_observed', operationId, phase: 'ambiguous' },
      ],
    };
  }

  async resume(): Promise<LifecycleDriverStep> {
    const replayHash = this.mutateReplay ? 'c'.repeat(64) : requestHash;
    this.requests.push(replayHash);
    return {
      observations: [
        { type: 'phase_observed', operationId, phase: 'reconciling' },
        {
          type: 'request_dispatched',
          operationId,
          requestKind: 'mint',
          method: 'POST',
          path: '/v1/mint/bolt11',
          bodyHash: replayHash,
        },
        {
          type: 'outputs_persisted',
          operationId,
          outputPlanHash: 'd'.repeat(64),
          amount: 64,
          unit: 'sat',
        },
        {
          type: 'mint_quote_observed',
          operationId,
          quoteHash: 'e'.repeat(64),
          amountPaid: 64,
          amountIssued: 64,
          updatedAt: 1,
        },
        {
          type: 'value_moved',
          operationId,
          effectId: 'mint_issue_1',
          unit: 'sat',
          amount: 64,
          from: 'external:fixture',
          to: 'wallet:alice:available',
        },
        { type: 'phase_observed', operationId, phase: 'succeeded' },
      ],
    };
  }
}

const scenario: LifecycleScenarioSpec = {
  id: 'mint-response-lost',
  seed: 'seed-42',
  requireQuiescence: true,
  commands: [
    { type: 'fault', rule: { action: 'drop_response', endpoint: 'mint', occurrence: 1 } },
    {
      type: 'start',
      input: { operationId, kind: 'mint', mint, unit: 'sat', amount: 64, method: 'bolt11' },
    },
    { type: 'clear_faults' },
    { type: 'resume', operationId },
  ],
};

describe('lifecycle scenario runner', () => {
  test('recovers a lost mint response with the same logical request', async () => {
    const driver = new MintRecoveryDriver();
    const result = await new LifecycleScenarioRunner(driver).run(scenario);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('scenario unexpectedly failed');
    expect(driver.requests).toEqual([requestHash, requestHash]);
    expect(result.history).toHaveLength(4);
    expect(result.model.observations).toHaveLength(11);
    expect(result.model.observations.at(-1)).toMatchObject({
      type: 'phase_observed',
      phase: 'succeeded',
    });
  });

  test('returns a sanitized replay artifact when exact request bytes change', async () => {
    const result = await new LifecycleScenarioRunner(new MintRecoveryDriver(true)).run(scenario);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('scenario unexpectedly passed');
    expect(result.artifact.failure).toMatchObject({
      commandIndex: 3,
      code: 'LIFECYCLE_INVARIANT',
      message: 'Lifecycle safety invariant failed.',
    });
    expect(result.artifact.failure.detailHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(result.artifact)).not.toContain('"body"');
    expect(JSON.stringify(result.artifact)).not.toContain('quoteId');
    expect(JSON.stringify(result.artifact)).not.toContain('request digest changed');
  });

  test('executes an explicit adapter restart boundary', async () => {
    const restarts: string[] = [];
    const driver = {
      async reset() {},
      async configureFault() {},
      async start() {
        return { observations: [] };
      },
      async resume() {
        return { observations: [] };
      },
      async restart(component: 'adapter' | 'mint') {
        restarts.push(component);
        return { observations: [] };
      },
    };
    const result = await new LifecycleScenarioRunner(driver).run({
      id: 'restart-boundary',
      seed: 'seed-restart',
      commands: [{ type: 'restart', component: 'adapter' }],
    } as unknown as LifecycleScenarioSpec);

    expect(result.ok).toBe(true);
    expect(restarts).toEqual(['adapter']);
  });

  test('dispatches bounded resume calls concurrently', async () => {
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const driver = {
      async reset() {},
      async configureFault() {},
      async start() {
        return { observations: [] };
      },
      async resume() {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { observations: [] };
      },
    };
    const result = await new LifecycleScenarioRunner(driver).run({
      id: 'concurrent-resume',
      seed: 'seed-concurrent',
      commands: [{ type: 'resume_concurrently', operationId: 'AAAAAAAAAAAAAAAAAAAAAA', count: 8 }],
    } as unknown as LifecycleScenarioSpec);

    expect(result.ok).toBe(true);
    expect(calls).toBe(8);
    expect(maximumActive).toBeGreaterThan(1);
  });
});
