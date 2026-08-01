import { createOperation } from '@cashu-fault-lab/wallet-lifecycle-core';
import { expect, test } from 'vitest';
import {
  LifecycleScenarioRunner,
  minimizeLifecycleFailure,
  replayLifecycleFailure,
  type LifecycleDriver,
  type LifecycleDriverStep,
  type LifecycleScenarioSpec,
} from '../src/index.js';

const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
const operation = createOperation({
  operationId,
  kind: 'mint',
  mint: 'http://127.0.0.1:3338',
  unit: 'sat',
  intentHash: 'a'.repeat(64),
});

class FailingDriver implements LifecycleDriver {
  async reset(): Promise<void> {}
  async configureFault(): Promise<void> {}
  async start(): Promise<LifecycleDriverStep> {
    return {
      observations: [
        { type: 'operation_observed', operation },
        { type: 'phase_observed', operationId, phase: 'submitted' },
      ],
    };
  }
  async resume(): Promise<LifecycleDriverStep> {
    return { observations: [] };
  }
}

const spec: LifecycleScenarioSpec = {
  id: 'illegal-transition',
  seed: 'seed-replay',
  commands: [
    {
      type: 'start',
      input: {
        operationId,
        kind: 'mint',
        mint: operation.mint,
        unit: 'sat',
        amount: 8,
        method: 'bolt11',
      },
    },
  ],
};

test('replay compares the complete normalized failure and observation history', async () => {
  const first = await new LifecycleScenarioRunner(new FailingDriver()).run(spec);
  expect(first.ok).toBe(false);
  if (first.ok) throw new Error('scenario unexpectedly passed');

  await expect(replayLifecycleFailure(first.artifact, new FailingDriver())).resolves.toEqual({
    matched: true,
    actual: first.artifact,
  });
});

test('shrinks commands that are irrelevant to the same failure identity', async () => {
  const noisy: LifecycleScenarioSpec = {
    ...spec,
    commands: [
      { type: 'fault', rule: { action: 'delay_response', endpoint: 'quote', occurrence: 1 } },
      { type: 'clear_faults' },
      ...spec.commands,
    ],
  };
  const first = await new LifecycleScenarioRunner(new FailingDriver()).run(noisy);
  expect(first.ok).toBe(false);
  if (first.ok) throw new Error('scenario unexpectedly passed');

  const minimized = await minimizeLifecycleFailure(first.artifact, () => new FailingDriver());

  expect(minimized.scenario.commands).toEqual(spec.commands);
  expect(minimized.failure.code).toBe(first.artifact.failure.code);
  expect(minimized.failure.message).toBe(first.artifact.failure.message);
});
