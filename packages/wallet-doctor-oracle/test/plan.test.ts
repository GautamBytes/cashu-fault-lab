import { describe, expect, it } from 'vitest';
import {
  initialPlanState,
  planStateUniqueBalance,
  reconstruct,
  simulatePlan,
  type DeletionView,
  type DoctorObservation,
  type MintObservation,
  type ProofView,
  type RelayObservation,
  type TokenEventView,
  type WalletEventView,
} from '@cashu-fault-lab/wallet-doctor-core';
import { buildRepairPlan, checkRepairPlan, diagnose } from '../src/index.js';

const A = 'ws://127.0.0.1:4430';
const B = 'ws://127.0.0.1:4431';
const MINT = 'http://127.0.0.1:3338';
const SUBJECT = 'ab'.repeat(32);
const DIGEST = 'sha256:' + '00'.repeat(32);

function proof(amount: number, y: string): ProofView {
  return { keysetId: '00ad268c4d1f5826', amount, y };
}

function token(
  eventId: string,
  proofs: readonly ProofView[],
  options: { del?: readonly string[]; seenOn?: readonly string[]; mint?: string } = {},
): TokenEventView {
  return {
    eventId,
    createdAt: 1_700_000_000,
    mint: options.mint ?? MINT,
    unit: 'sat',
    proofs,
    del: options.del ?? [],
    seenOn: options.seenOn ?? [A],
  };
}

function del(eventId: string, targets: readonly string[], seenOn: readonly string[]): DeletionView {
  return { eventId, createdAt: 1_700_000_100, targets, kinds: [7375], seenOn };
}

function wallet(eventId: string, createdAt: number, seenOn: readonly string[]): WalletEventView {
  return { eventId, createdAt, mints: [MINT], hasP2pkKey: true, seenOn };
}

function relay(url: string, events: Partial<RelayObservation> = {}): RelayObservation {
  return {
    url,
    status: 'ok',
    error: null,
    wallet: [wallet('w1', 1_700_000_000, [url])],
    tokens: [],
    deletions: [],
    history: [],
    quotes: [],
    malformed: [],
    ...events,
  };
}

function runPipeline(observation: DoctorObservation) {
  const diagnosis = diagnose(observation);
  const plan = buildRepairPlan({ observation, diagnosis, captureDigest: DIGEST });
  const check = checkRepairPlan({ observation, plan });
  return { diagnosis, plan, check };
}

describe('buildRepairPlan + checkRepairPlan', () => {
  it('produces an empty, valid plan for a healthy wallet', () => {
    const t1 = token('e1', [proof(2, 'y1')], { seenOn: [A, B] });
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [relay(A, { tokens: [t1] }), relay(B, { tokens: [t1] })],
      mint: [{ mint: MINT, y: 'y1', state: 'UNSPENT' }],
    };
    const { plan, check } = runPipeline(observation);
    expect(plan.steps).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.violations).toEqual([]);
  });

  it('repairs a ghost token by rolling over only the surviving proofs', () => {
    const t1 = token('e1', [proof(2, 'y1'), proof(4, 'y2')], { seenOn: [A, B] });
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [relay(A, { tokens: [t1] }), relay(B, { tokens: [t1] })],
      mint: [
        { mint: MINT, y: 'y1', state: 'SPENT' },
        { mint: MINT, y: 'y2', state: 'UNSPENT' },
      ],
    };
    const { diagnosis, plan, check } = runPipeline(observation);
    expect(diagnosis.findings.map((finding) => finding.code)).toContain('GHOST_TOKEN');
    expect(plan.steps.map((step) => step.action)).toEqual(['publish_rollover', 'delete_events']);
    const rollover = plan.steps[0];
    if (rollover?.action !== 'publish_rollover') throw new Error('expected rollover');
    expect(rollover.coveredYs).toEqual(['y2']);
    expect(rollover.del).toEqual(['e1']);
    expect(check.ok).toBe(true);

    const { merged } = reconstruct(observation);
    const allTokens = [...merged.liveTokens];
    const finalState = simulatePlan(initialPlanState(merged.liveTokens, allTokens), plan.steps);
    expect(planStateUniqueBalance(finalState)).toBe(4);
  });

  it('repairs a del-chain break with consolidation, not republishing', () => {
    const old = token('e1', [proof(4, 'y1'), proof(8, 'y2')], { seenOn: [B] });
    const rolled = token('e2', [proof(8, 'y2')], { del: ['e1'], seenOn: [A] });
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [
        relay(A, { tokens: [rolled], deletions: [del('d1', ['e1'], [A])] }),
        relay(B, { tokens: [old] }),
      ],
      mint: [
        { mint: MINT, y: 'y1', state: 'SPENT' },
        { mint: MINT, y: 'y2', state: 'UNSPENT' },
      ],
    };
    const { plan, check } = runPipeline(observation);
    expect(plan.steps.map((step) => step.action)).toEqual(['publish_rollover', 'delete_events']);
    const rollover = plan.steps[0];
    if (rollover?.action !== 'publish_rollover') throw new Error('expected rollover');
    expect(rollover.coveredYs).toEqual(['y2']);
    expect(rollover.del).toEqual(['e1', 'e2']);
    const deletion = plan.steps[1];
    if (deletion?.action !== 'delete_events') throw new Error('expected deletion');
    expect(deletion.eventIds).toEqual(['e1', 'e2']);
    expect(check.ok).toBe(true);
  });

  it('republishes healthy partitioned events without consolidation', () => {
    const t1 = token('e1', [proof(2, 'y1')], { seenOn: [A] });
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [relay(A, { tokens: [t1] }), relay(B)],
      mint: [{ mint: MINT, y: 'y1', state: 'UNSPENT' }],
    };
    const { plan, check } = runPipeline(observation);
    expect(plan.steps).toEqual([{ action: 'republish_event', eventId: 'e1', toRelays: [B] }]);
    expect(check.ok).toBe(true);
  });

  it('emits a wallet action for orphaned unspent proofs', () => {
    const t1 = token('e1', [proof(8, 'y1')], { seenOn: [A, B] });
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [
        relay(A, { tokens: [t1], deletions: [del('d1', ['e1'], [A])] }),
        relay(B, { tokens: [t1], deletions: [del('d1', ['e1'], [B])] }),
      ],
      mint: [{ mint: MINT, y: 'y1', state: 'UNSPENT' }],
    };
    const { plan, check } = runPipeline(observation);
    expect(plan.steps).toEqual([
      { action: 'wallet_action', kind: 'nut09_restore', mint: MINT, ys: ['y1'] },
    ]);
    expect(check.ok).toBe(true);
  });

  it('keeps orphan recovery scoped by mint when two mints share the same Y', () => {
    const otherMint = 'https://other-mint.example';
    const first = token('e1', [proof(8, 'shared-y')], { seenOn: [A, B] });
    const second = token('e2', [proof(4, 'shared-y')], {
      mint: otherMint,
      seenOn: [A, B],
    });
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [
        relay(A, {
          tokens: [first, second],
          deletions: [del('d1', ['e1', 'e2'], [A])],
        }),
        relay(B, {
          tokens: [first, second],
          deletions: [del('d1', ['e1', 'e2'], [B])],
        }),
      ],
      mint: [
        { mint: MINT, y: 'shared-y', state: 'UNSPENT' },
        { mint: otherMint, y: 'shared-y', state: 'UNSPENT' },
      ],
    };
    const { plan, check } = runPipeline(observation);
    expect(plan.steps).toEqual([
      { action: 'wallet_action', kind: 'nut09_restore', mint: MINT, ys: ['shared-y'] },
      { action: 'wallet_action', kind: 'nut09_restore', mint: otherMint, ys: ['shared-y'] },
    ]);
    expect(check.ok).toBe(true);
  });

  it('republishes the latest wallet event to stale relays', () => {
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [
        relay(A, { wallet: [wallet('w2', 1_700_000_500, [A])] }),
        relay(B, { wallet: [wallet('w1', 1_700_000_000, [B])] }),
      ],
      mint: [],
    };
    const { plan, check } = runPipeline(observation);
    expect(plan.steps).toEqual([
      { action: 'republish_wallet_event', eventId: 'w2', toRelays: [B] },
    ]);
    expect(check.ok).toBe(true);
  });

  it('flags a hand-written unsafe plan that drops an unspent proof (P1)', () => {
    const t1 = token('e1', [proof(2, 'y1'), proof(4, 'y2')], { seenOn: [A] });
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [relay(A, { tokens: [t1] })],
      mint: [
        { mint: MINT, y: 'y1', state: 'UNSPENT' },
        { mint: MINT, y: 'y2', state: 'UNSPENT' },
      ],
    };
    const badPlan = {
      schemaVersion: 1 as const,
      subject: SUBJECT,
      captureDigest: DIGEST,
      steps: [{ action: 'delete_events' as const, eventIds: ['e1'], toRelays: [A] }],
    };
    const check = checkRepairPlan({ observation, plan: badPlan });
    expect(check.ok).toBe(false);
    expect(check.violations.some((violation) => violation.startsWith('P1_UNCOVERED_UNSPENT'))).toBe(
      true,
    );
  });

  it('flags a rollover whose del list drops an uncovered UNSPENT proof (P1 via del)', () => {
    const live = token('e2', [proof(4, 'y2')], { del: ['e1'], seenOn: [A] });
    const broken = token('e9', [proof(8, 'y8')], { seenOn: [B] });
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [relay(A, { tokens: [live] }), relay(B, { tokens: [broken] })],
      mint: [
        { mint: MINT, y: 'y2', state: 'UNSPENT' },
        { mint: MINT, y: 'y8', state: 'UNSPENT' },
      ],
    };
    const badPlan = {
      schemaVersion: 1 as const,
      subject: SUBJECT,
      captureDigest: DIGEST,
      steps: [
        {
          action: 'publish_rollover' as const,
          rolloverId: 'planned:rollover:0',
          mint: MINT,
          unit: 'sat',
          coveredYs: ['y2'],
          del: ['e9', 'e2'],
          toRelays: [A, B],
        },
      ],
    };
    const check = checkRepairPlan({ observation, plan: badPlan });
    expect(check.ok).toBe(false);
    expect(check.violations.some((violation) => violation.includes('y8'))).toBe(true);
    expect(check.violations.some((violation) => violation.startsWith('P1_UNCOVERED_UNSPENT'))).toBe(
      true,
    );
  });

  it('refuses consolidation when mint truth is incomplete for a proof it would delete', () => {
    const old = token('e1', [proof(4, 'y1'), proof(8, 'y2')], { seenOn: [B] });
    const rolled = token('e2', [proof(8, 'y2')], { del: ['e1'], seenOn: [A] });
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [
        relay(A, { tokens: [rolled], deletions: [del('d1', ['e1'], [A])] }),
        relay(B, { tokens: [old] }),
      ],
      // y1 deliberately unchecked — incomplete truth over the broken predecessor.
      mint: [{ mint: MINT, y: 'y2', state: 'UNSPENT' }],
    };
    const { plan, check } = runPipeline(observation);
    expect(plan.steps).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('flags unknown references (P3)', () => {
    const observation: DoctorObservation = {
      subject: SUBJECT,
      relays: [relay(A)],
      mint: [],
    };
    const badPlan = {
      schemaVersion: 1 as const,
      subject: SUBJECT,
      captureDigest: DIGEST,
      steps: [
        { action: 'delete_events' as const, eventIds: ['nope'], toRelays: [A] },
        { action: 'republish_event' as const, eventId: 'ghost', toRelays: [B] },
      ],
    };
    const check = checkRepairPlan({ observation, plan: badPlan });
    expect(check.ok).toBe(false);
    expect(check.violations.filter((violation) => violation.startsWith('P3_')).length).toBe(2);
  });
});
