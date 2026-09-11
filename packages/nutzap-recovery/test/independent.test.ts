import { expect, it } from 'vitest';
import { runNutzapScenario, verifyNutzapEvidence } from '../src/runner.js';
import { replayNutzapReport } from '../src/replay.js';

it.each(['independent-concurrent', 'independent-crash-after-swap', 'independent-relay-outage'])(
  '%s uses independent journals and converges through relays',
  async (id) => {
    const report = await runNutzapScenario(id, 'independent-test');
    expect(report.status, JSON.stringify(report)).toBe('passed');
    expect(report.evidence.independent).toMatchObject({
      databasesDistinct: true,
      plansDistinct: true,
      swapAttempts: 2,
      successfulSwaps: 1,
      localCredits: [0, 1],
      replicatedWallets: 1,
      walletEventsAgree: true,
      awaitingPeerObserved: true,
    });
    expect(report.evidence.independent!.walletBalances).toEqual([
      report.evidence.outputAmount,
      report.evidence.outputAmount,
    ]);
    if (id === 'independent-crash-after-swap') expect(report.evidence.killedAfterSwap).toBe(true);
    if (id === 'independent-relay-outage')
      expect(report.evidence.independent!.relayOutageObserved).toBe(true);
    for (const patch of [
      { databasesDistinct: false },
      { plansDistinct: false },
      { successfulSwaps: 2 },
      { localCredits: [1, 1] },
      { walletBalances: [0, 0] },
      { replicatedWallets: 0 },
      { walletEventsAgree: false },
      { awaitingPeerObserved: false },
    ]) {
      expect(
        verifyNutzapEvidence(
          { ...report.evidence, independent: { ...report.evidence.independent!, ...patch } },
          id,
        ).ok,
      ).toBe(false);
    }
  },
  60_000,
);
it('replays independent crash evidence without depending on which wallet won the race', async () => {
  const report = await runNutzapScenario('independent-crash-after-swap', 'independent-replay');
  const replay = await replayNutzapReport(report, 'independent-replay');
  expect(replay.status).toBe('passed');
  expect(replay.fingerprint).toBe(report.fingerprint);
}, 60_000);
