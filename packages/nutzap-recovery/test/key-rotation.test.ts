import { expect, it } from 'vitest';
import { runNutzapScenario, verifyNutzapEvidence } from '../src/runner.js';
import { replayNutzapReport } from '../src/replay.js';

it.each(['key-rotation-delayed', 'key-rotation-crash-after-swap', 'key-rotation-missing-key'])(
  '%s: recovers old and new payments once without advertisement rollback',
  async (id) => {
    const report = await runNutzapScenario(id, 'rotation-regression');
    expect(report.status, JSON.stringify(report)).toBe('passed');
    const r = report.evidence.rotation!;
    expect(r.totalCredits).toBe(2);
    expect(r.totalBalance).toBe(30);
    expect(r.newPayment.credits).toBe(1);
    expect(r.missingKeyBlocked).toBe(id === 'key-rotation-missing-key');
    expect(report.evidence.killedAfterSwap).toBe(id === 'key-rotation-crash-after-swap');
    for (const patch of [
      { staleAdvertisementRejected: false },
      { newKeyUsed: false },
      { oldKeyRecovered: false },
      { privateState: false },
      { totalCredits: 3 },
      { totalBalance: 32 },
      { duplicateStable: false },
      { missingKeyBlocked: !r.missingKeyBlocked },
      { newPayment: { ...r.newPayment, unspentOutputs: 0 } },
    ])
      expect(
        verifyNutzapEvidence({ ...report.evidence, rotation: { ...r, ...patch } }, id).ok,
      ).toBe(false);
    const { rotation: _rotation, ...withoutRotation } = report.evidence;
    expect(verifyNutzapEvidence(withoutRotation, id).ok).toBe(false);
    expect((await replayNutzapReport(report, 'rotation-regression')).fingerprint).toBe(
      report.fingerprint,
    );
    expect(JSON.stringify(report)).not.toMatch(/privkey|keyHex|"secret"|"proofs"/u);
  },
  60_000,
);
