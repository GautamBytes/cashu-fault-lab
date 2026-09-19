import { expect, it } from 'vitest';
import { runNutzapScenario, verifyNutzapEvidence } from '../src/runner.js';
import { replayNutzapReport } from '../src/replay.js';

it.each(['sender-relay-stale-list', 'sender-relay-outage', 'sender-relay-response-lost'])(
  '%s: delivers the original history to read relays with one economic credit',
  async (id) => {
    const report = await runNutzapScenario(id, 'sender-routing-regression');
    expect(report.status, JSON.stringify(report)).toBe('passed');
    expect(report.evidence.senderRelays?.historyCounts).toEqual([1, 1]);
    expect(report.evidence.senderRelays?.tokenCounts).toEqual([0, 0]);
    expect(report.evidence.senderRelays?.offlineObserved).toBe(id === 'sender-relay-outage');
    for (const patch of [
      { historyCounts: [1, 0] },
      { tokenCounts: [0, 1] },
      { writeOnlyEvents: 1 },
      { outboxStable: false },
      { staleListRejected: false },
      { offlineObserved: id !== 'sender-relay-outage' },
    ])
      expect(
        verifyNutzapEvidence(
          { ...report.evidence, senderRelays: { ...report.evidence.senderRelays!, ...patch } },
          id,
        ).ok,
      ).toBe(false);
    const { senderRelays: _routing, ...missing } = report.evidence;
    expect(verifyNutzapEvidence(missing, id).ok).toBe(false);
    expect((await replayNutzapReport(report, 'sender-routing-regression')).fingerprint).toBe(
      report.fingerprint,
    );
    expect(JSON.stringify(report)).not.toMatch(/"secret"|"proofs"|keyHex|privkey/u);
  },
  60_000,
);
