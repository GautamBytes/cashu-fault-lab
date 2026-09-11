import { expect, it } from 'vitest';
import { runNutzapScenario, validateRun } from '../src/runner.js';

it.each(['cdk-concurrent', 'cdk-crash-after-swap', 'cdk-peer-crash-after-swap'])(
  'recognizes funded cross-language scenario %s without falling back to simulation',
  async (scenario) => {
    expect(() => validateRun(scenario, 'cdk-test')).not.toThrow();
    await expect(runNutzapScenario(scenario, 'cdk-test')).rejects.toThrow(
      'CDK scenarios require a disposable mint URL and receiver binary',
    );
  },
);
