import { expect, it } from 'vitest';
import { runNutzapScenario, validateRun, CDK_SCENARIOS } from '../src/runner.js';

it.each(CDK_SCENARIOS)(
  'recognizes funded native scenario %s without falling back to simulation',
  async (scenario) => {
    expect(() => validateRun(scenario, 'cdk-test')).not.toThrow();
    await expect(runNutzapScenario(scenario, 'cdk-test')).rejects.toThrow(
      'CDK scenarios require a disposable mint URL and receiver binary',
    );
  },
);
