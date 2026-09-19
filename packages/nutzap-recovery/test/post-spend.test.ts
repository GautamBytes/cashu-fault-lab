import { expect, it } from 'vitest';
import { runNutzapScenario, verifyNutzapEvidence } from '../src/runner.js';
import { replayNutzapReport } from '../src/replay.js';

it.each(['post-spend-stale-relay', 'post-spend-publication-crash'])(
  '%s converges after spending without resurrecting the original balance',
  async (id) => {
    const report = await runNutzapScenario(id, 'post-spend-test');
    expect(report.status, JSON.stringify(report)).toBe('passed');
    expect(report.evidence.postSpend?.walletBalances).toEqual([10, 10]);
    expect(report.evidence.postSpend?.credits).toBe(1);
    expect(report.evidence.postSpend?.staleBalance).toBe(0);
    expect(report.evidence.postSpend?.recipientAmount).toBe(3);
    expect(report.evidence.postSpend?.publicationCrashObserved).toBe(id.endsWith('crash'));
    for (const patch of [
      { walletBalances: [15, 15] },
      { staleBalance: 15 },
      { credits: 2 },
      { recipientAmount: 4 },
      { retiredTokenRejected: false },
      { relayEventsAgree: false },
    ]) {
      expect(
        verifyNutzapEvidence(
          { ...report.evidence, postSpend: { ...report.evidence.postSpend!, ...patch } },
          id,
        ).ok,
      ).toBe(false);
    }
    const replay = await replayNutzapReport(report, 'post-spend-test');
    expect(replay.fingerprint).toBe(report.fingerprint);
  },
  60_000,
);
