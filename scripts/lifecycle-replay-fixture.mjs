import { createOperation } from '../packages/wallet-lifecycle-core/dist/index.js';
import {
  LifecycleScenarioRunner,
  replayLifecycleFailure,
} from '../packages/wallet-lifecycle-runner/dist/index.js';

const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
const seed = 'wallet-lifecycle-clean-checkout-replay-v1';
const operation = createOperation({
  operationId,
  kind: 'mint',
  mint: 'http://127.0.0.1:3338',
  unit: 'sat',
  intentHash: 'a'.repeat(64),
});
const scenario = {
  id: 'clean-checkout-illegal-transition',
  seed,
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

class DeterministicFailingDriver {
  async reset() {}
  async configureFault() {}
  async start() {
    return {
      observations: [
        { type: 'operation_observed', operation },
        { type: 'phase_observed', operationId, phase: 'submitted' },
      ],
    };
  }
  async resume() {
    return { observations: [] };
  }
}

const result = await new LifecycleScenarioRunner(new DeterministicFailingDriver()).run(scenario);
if (result.ok) throw new Error('Clean-checkout replay fixture unexpectedly passed');
const replay = await replayLifecycleFailure(
  result.artifact,
  new DeterministicFailingDriver(),
  seed,
);
if (!replay.matched || replay.actual === undefined) {
  throw new Error('Clean-checkout replay fixture did not match');
}
const expected = JSON.stringify(result.artifact);
const actual = JSON.stringify(replay.actual);
if (expected !== actual) throw new Error('Clean-checkout replay artifact bytes changed');
process.stdout.write(`${actual}\n`);
