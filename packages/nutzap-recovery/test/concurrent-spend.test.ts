import { expect, it } from 'vitest';
import { runNutzapScenario } from '../src/runner.js';
import { verifyNutzapEvidence } from '../src/evidence.js';
import { replayNutzapReport } from '../src/replay.js';

it.each(['concurrent-spend', 'concurrent-spend-crash-after-swap'])(
  '%s: two independent processes cannot pay both recipients',
  async (id) => {
    const result = await runNutzapScenario(id, 'spend-race');
    expect(result.failures).toEqual([]);
    expect(result.status).toBe('passed');
    expect(result.evidence.concurrentSpend).toMatchObject({
      results: ['complete', 'spend-conflict'],
      recipientBalances: [3, 0],
      walletBalances: [10, 10],
      swapAttempts: 2,
      successfulSwaps: 1,
    });
    for (const patch of [
      { winner: 1 },
      { swapAttempts: 1 },
      { successfulSwaps: 2 },
      { databasesDistinct: false },
      { plansDistinct: false },
      { plansStable: false },
      { partitionObserved: false },
      { partitionBalance: 15 },
      { crashObserved: !id.endsWith('crash-after-swap') },
      { results: ['complete', 'complete'] },
      { loserHasNoPayment: false },
      { fee: -1 },
      { recipientBalances: [3, 3] },
      { recipientFees: [0, 0] },
      { amount: 5 },
      { walletBalances: [15, 15] },
      { credits: 2 },
      { proofCounts: [] },
      { stateCounts: [0, 0, 0, 0] },
      { retiredTokenRejected: false },
      { outboxStable: false },
      { relayEventsAgree: false },
      { nativeSyncObserved: true },
    ])
      expect(
        verifyNutzapEvidence(
          {
            ...result.evidence,
            concurrentSpend: { ...result.evidence.concurrentSpend!, ...patch },
          },
          id,
        ).ok,
        JSON.stringify(patch),
      ).toBe(false);
    const { concurrentSpend: _race, ...withoutRace } = result.evidence;
    expect(verifyNutzapEvidence(withoutRace, id).ok).toBe(false);
    const replay = await replayNutzapReport(result, 'spend-race');
    expect(replay.status).toBe('passed');
    expect(replay.fingerprint).toBe(result.fingerprint);
  },
  60_000,
);
