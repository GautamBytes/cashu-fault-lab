import { describe, expect, it } from 'vitest';
import {
  initialPlanState,
  planStateBalance,
  planStateUniqueBalance,
  simulatePlan,
  type ProofView,
  type RepairStep,
  type TokenEventView,
} from '../src/index.js';

const MINT = 'http://127.0.0.1:3338';

function proof(amount: number, y: string): ProofView {
  return { keysetId: '00ad268c4d1f5826', amount, y };
}

function token(
  eventId: string,
  proofs: readonly ProofView[],
  del: readonly string[] = [],
): TokenEventView {
  return {
    eventId,
    createdAt: 1_700_000_000,
    mint: MINT,
    unit: 'sat',
    proofs,
    del,
    seenOn: ['ws://127.0.0.1:4430'],
  };
}

describe('simulatePlan', () => {
  const e1 = token('e1', [proof(4, 'y1'), proof(8, 'y2')]);
  const e2 = token('e2', [proof(8, 'y2')], ['e1']);

  it('replaces del targets with the rollover covering given proofs', () => {
    const state = initialPlanState([e1, e2], [e1, e2]);
    const steps: RepairStep[] = [
      {
        action: 'publish_rollover',
        rolloverId: 'planned:rollover:0',
        mint: MINT,
        unit: 'sat',
        coveredYs: ['y2'],
        del: ['e1', 'e2'],
        toRelays: ['ws://127.0.0.1:4430'],
      },
    ];
    const next = simulatePlan(state, steps);
    expect([...next.liveTokens.keys()]).toEqual(['planned:rollover:0']);
    expect(planStateBalance(next)).toBe(8);
  });

  it('is idempotent: applying steps twice equals applying them once', () => {
    const state = initialPlanState([e1, e2], [e1, e2]);
    const steps: RepairStep[] = [
      { action: 'delete_events', eventIds: ['e1'], toRelays: ['ws://127.0.0.1:4430'] },
      {
        action: 'publish_rollover',
        rolloverId: 'planned:rollover:0',
        mint: MINT,
        unit: 'sat',
        coveredYs: ['y2'],
        del: ['e2'],
        toRelays: ['ws://127.0.0.1:4430'],
      },
    ];
    const once = simulatePlan(state, steps);
    const twice = simulatePlan(once, steps);
    expect([...twice.liveTokens.keys()]).toEqual([...once.liveTokens.keys()]);
    expect(planStateBalance(twice)).toBe(planStateBalance(once));
  });

  it('rejects rollovers covering unknown proofs', () => {
    const state = initialPlanState([e1], [e1]);
    expect(() =>
      simulatePlan(state, [
        {
          action: 'publish_rollover',
          rolloverId: 'planned:rollover:0',
          mint: MINT,
          unit: 'sat',
          coveredYs: ['y-unknown'],
          del: ['e1'],
          toRelays: ['ws://127.0.0.1:4430'],
        },
      ]),
    ).toThrow(/unknown proof y/u);
  });

  it('counts duplicate proofs once in the unique balance', () => {
    const dup1 = token('e1', [proof(8, 'y2')]);
    const dup2 = token('e3', [proof(8, 'y2')]);
    const state = initialPlanState([dup1, dup2], [dup1, dup2]);
    expect(planStateBalance(state)).toBe(16);
    expect(planStateUniqueBalance(state)).toBe(8);
  });
});
