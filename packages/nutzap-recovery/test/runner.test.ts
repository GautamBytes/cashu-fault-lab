import { describe, expect, it } from 'vitest';
import { runNutzapScenario, SCENARIOS, verifyNutzapEvidence } from '../src/runner.js';
describe('NIP-61 process and relay suite', () => {
  it.each([
    'duplicate-relays',
    'concurrent-redemption',
    'crash-after-swap',
    'swap-response-lost',
    'publish-response-lost',
  ])(
    'proves %s with one credit and converged relay history',
    async (id) => {
      const result = await runNutzapScenario(id, 'regression-seed');
      expect(result.status).toBe('passed');
      expect(result.evidence.credits).toBe(1);
      expect(result.evidence.inputAmount).toBe(result.evidence.outputAmount + result.evidence.fee);
      expect(result.mode).toBe('simulated');
      if (id === 'crash-after-swap') expect(result.evidence.killedAfterSwap).toBe(true);
    },
    30_000,
  );
  it('has a bounded corpus and rejects unknown cases before starting infrastructure', async () => {
    expect(SCENARIOS).toHaveLength(8);
    await expect(runNutzapScenario('../bad', 'seed')).rejects.toThrow();
  });
  it('detects duplicate credit and missing history rather than trusting receiver status', async () => {
    const result = await runNutzapScenario('duplicate-relays', 'canary');
    expect(verifyNutzapEvidence({ ...result.evidence, credits: 2 }).ok).toBe(false);
    expect(verifyNutzapEvidence({ ...result.evidence, historyCounts: [1, 0] }).ok).toBe(false);
    expect(verifyNutzapEvidence({ ...result.evidence, outputAmount: 999 }).ok).toBe(false);
    expect(verifyNutzapEvidence({ ...result.evidence, walletPayloadsMatch: false }).ok).toBe(false);
    expect(
      verifyNutzapEvidence({ ...result.evidence, killedAfterSwap: false }, 'crash-after-swap').ok,
    ).toBe(false);
    expect(
      verifyNutzapEvidence({ ...result.evidence, inputProofs: 0.5, spentInputs: 0.5 }).ok,
    ).toBe(false);
  }, 30_000);
});
