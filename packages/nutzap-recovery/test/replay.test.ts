import { describe, expect, it } from 'vitest';
import { runNutzapScenario } from '../src/runner.js';
import { replayNutzapReport } from '../src/replay.js';
describe('nutzap replay evidence', () => {
  it('reproduces semantic evidence with fresh secrets and rejects tampering and wrong seeds', async () => {
    const original = await runNutzapScenario('crash-after-swap', 'replay-seed');
    const replay = await replayNutzapReport(original, 'replay-seed');
    expect(replay.fingerprint).toBe(original.fingerprint);
    await expect(
      replayNutzapReport(
        { ...original, evidence: { ...original.evidence, credits: 9 } },
        'replay-seed',
      ),
    ).rejects.toThrow();
    await expect(replayNutzapReport(original, 'wrong')).rejects.toThrow();
  }, 30_000);
});
