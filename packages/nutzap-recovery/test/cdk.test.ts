import { expect, it } from 'vitest';
import { runNutzapScenario, validateRun } from '../src/runner.js';

it.each([
  'cdk-key-rotation-delayed',
  'cdk-key-rotation-crash-after-swap',
  'cdk-key-rotation-missing-key',
  'cdk-concurrent',
  'cdk-crash-after-swap',
  'cdk-peer-crash-after-swap',
  'cdk-post-spend-stale-relay',
  'cdk-post-spend-publication-crash',
  'cdk-peer-post-spend-stale-relay',
  'cdk-peer-post-spend-publication-crash',
])(
  'recognizes funded native scenario %s without falling back to simulation',
  async (scenario) => {
    expect(() => validateRun(scenario, 'cdk-test')).not.toThrow();
    await expect(runNutzapScenario(scenario, 'cdk-test')).rejects.toThrow(
      'CDK scenarios require a disposable mint URL and receiver binary',
    );
  },
);
