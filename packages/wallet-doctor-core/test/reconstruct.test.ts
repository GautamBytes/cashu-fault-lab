import { describe, expect, it } from 'vitest';
import {
  dedupeEvents,
  reconstruct,
  reconstructMerged,
  reconstructRelay,
  type DeletionView,
  type ProofView,
  type RelayObservation,
  type TokenEventView,
  type WalletEventView,
} from '../src/index.js';

const RELAY_A = 'ws://127.0.0.1:4430';
const RELAY_B = 'ws://127.0.0.1:4431';
const MINT = 'http://127.0.0.1:3338';

let proofCounter = 0;
function proof(amount: number, y?: string): ProofView {
  proofCounter += 1;
  return {
    keysetId: '00ad268c4d1f5826',
    amount,
    y: y ?? `02${proofCounter.toString().padStart(64, '0')}`,
  };
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
    seenOn: options.seenOn ?? [RELAY_A],
  };
}

function deletion(
  eventId: string,
  targets: readonly string[],
  seenOn: readonly string[],
): DeletionView {
  return { eventId, createdAt: 1_700_000_100, targets, kinds: [7375], seenOn };
}

function relay(url: string, events: Partial<RelayObservation> = {}): RelayObservation {
  return {
    url,
    status: 'ok',
    error: null,
    wallet: [],
    tokens: [],
    deletions: [],
    history: [],
    quotes: [],
    malformed: [],
    ...events,
  };
}

describe('dedupeEvents', () => {
  it('merges seenOn lists for the same event id', () => {
    const t1 = token('e1', [proof(1)], { seenOn: [RELAY_B] });
    const t2 = token('e1', [proof(1)], { seenOn: [RELAY_A] });
    const merged = dedupeEvents([t1, t2]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.seenOn).toEqual([RELAY_A, RELAY_B]);
  });
});

describe('reconstructRelay', () => {
  it('drops events the same relay serves a deletion for', () => {
    const t1 = token('e1', [proof(4)]);
    const t2 = token('e2', [proof(8)]);
    const view = reconstructRelay(
      relay(RELAY_A, { tokens: [t1, t2], deletions: [deletion('d1', ['e1'], [RELAY_A])] }),
    );
    expect(view.liveTokens.map((t) => t.eventId)).toEqual(['e2']);
    expect(view.balance).toBe(8);
  });

  it('returns an empty error view for unreachable relays', () => {
    const view = reconstructRelay(relay(RELAY_A, { status: 'error', error: 'timeout' }));
    expect(view.status).toBe('error');
    expect(view.balance).toBe(0);
  });

  it('selects the latest wallet event by created_at with id tie-break', () => {
    const higherId: WalletEventView = {
      eventId: 'zzz',
      createdAt: 200,
      mints: [MINT],
      hasP2pkKey: true,
      seenOn: [RELAY_A],
    };
    const lowerId: WalletEventView = { ...higherId, eventId: 'aaa' };
    const view = reconstructRelay(relay(RELAY_A, { wallet: [higherId, lowerId] }));
    expect(view.walletEvent?.eventId).toBe('aaa');
  });
});

describe('reconstructMerged', () => {
  it('supersedes events referenced by a successor del chain', () => {
    const p1 = proof(4, 'y1');
    const p2 = proof(8, 'y2');
    const old = token('e1', [p1, p2], { seenOn: [RELAY_A] });
    const rolled = token('e2', [p2], { del: ['e1'], seenOn: [RELAY_A] });
    const merged = reconstructMerged([
      relay(RELAY_A, { tokens: [old, rolled], deletions: [deletion('d1', ['e1'], [RELAY_A])] }),
    ]);
    expect(merged.liveTokens.map((t) => t.eventId)).toEqual(['e2']);
    expect(merged.balance).toBe(8);
    expect(merged.orphanCandidates.map((o) => o.y)).toEqual(['y1']);
  });

  it('detects naive double counting when a predecessor stays live on another relay', () => {
    const shared = proof(8, 'y-shared');
    const old = token('e1', [shared], { seenOn: [RELAY_B] });
    const rolled = token('e2', [shared], { del: ['e1'], seenOn: [RELAY_A] });
    const merged = reconstructMerged([
      relay(RELAY_A, {
        tokens: [rolled],
        deletions: [deletion('d1', ['e1'], [RELAY_A])],
      }),
      relay(RELAY_B, { tokens: [old] }),
    ]);
    expect(merged.liveTokens.map((t) => t.eventId)).toEqual(['e2']);
    expect(merged.balance).toBe(8);
    expect(merged.naiveBalance).toBe(16);
    expect(merged.doubleCounted).toBe(8);
    expect(merged.duplicateProofs).toEqual([{ y: 'y-shared', amount: 8, eventIds: ['e1', 'e2'] }]);
  });

  it('treats the same Y from different mints as two distinct proofs', () => {
    const sharedY = proof(4, 'y-shared-across-mints');
    const mintA = token('e-mint-a', [sharedY], { mint: 'https://mint-a.example' });
    const mintB = token('e-mint-b', [sharedY], { mint: 'https://mint-b.example' });
    const merged = reconstructMerged([relay(RELAY_A, { tokens: [mintA, mintB] })]);
    expect(merged.balance).toBe(8);
    expect(merged.naiveBalance).toBe(8);
    expect(merged.doubleCounted).toBe(0);
    expect(merged.duplicateProofs).toEqual([]);
  });

  it('treats a globally deleted event as gone even without a successor', () => {
    const ghost = token('e1', [proof(32)], { seenOn: [RELAY_A, RELAY_B] });
    const merged = reconstructMerged([
      relay(RELAY_A, { tokens: [ghost], deletions: [deletion('d1', ['e1'], [RELAY_A])] }),
      relay(RELAY_B, { tokens: [ghost] }),
    ]);
    expect(merged.liveTokens).toHaveLength(0);
    expect(merged.balance).toBe(0);
    expect(merged.orphanCandidates).toHaveLength(1);
  });

  it('keeps a healthy partitioned wallet consistent', () => {
    const t1 = token('e1', [proof(2)], { seenOn: [RELAY_A, RELAY_B] });
    const merged = reconstructMerged([
      relay(RELAY_A, { tokens: [t1] }),
      relay(RELAY_B, { tokens: [t1] }),
    ]);
    expect(merged.balance).toBe(2);
    expect(merged.naiveBalance).toBe(2);
    expect(merged.doubleCounted).toBe(0);
    expect(merged.orphanCandidates).toHaveLength(0);
  });
});

describe('reconstruct', () => {
  it('builds per-relay and merged views from one observation', () => {
    const t1 = token('e1', [proof(1)], { seenOn: [RELAY_A] });
    const result = reconstruct({
      subject: 'ab'.repeat(32),
      relays: [relay(RELAY_A, { tokens: [t1] }), relay(RELAY_B)],
      mint: [],
    });
    expect(result.perRelay).toHaveLength(2);
    expect(result.perRelay[0]?.balance).toBe(1);
    expect(result.perRelay[1]?.balance).toBe(0);
    expect(result.merged.balance).toBe(1);
  });
});
