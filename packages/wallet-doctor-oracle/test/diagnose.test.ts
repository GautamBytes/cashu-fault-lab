import { describe, expect, it } from 'vitest';
import type {
  DeletionView,
  DoctorObservation,
  MintObservation,
  ProofView,
  RelayObservation,
  TokenEventView,
  WalletEventView,
} from '@cashu-fault-lab/wallet-doctor-core';
import { diagnose } from '../src/index.js';

const A = 'ws://127.0.0.1:4430';
const B = 'ws://127.0.0.1:4431';
const MINT = 'http://127.0.0.1:3338';
const SUBJECT = 'ab'.repeat(32);

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

function observe(
  relays: readonly RelayObservation[],
  mint: readonly MintObservation[],
): DoctorObservation {
  return { subject: SUBJECT, relays, mint };
}

describe('diagnose: healthy wallet', () => {
  it('emits zero findings and matching balances (no false positives)', () => {
    const t1 = token('e1', [proof(2, 'y1'), proof(4, 'y2')], { seenOn: [A, B] });
    const observation = observe(
      [relay(A, { tokens: [t1] }), relay(B, { tokens: [t1] })],
      [
        { mint: MINT, y: 'y1', state: 'UNSPENT' },
        { mint: MINT, y: 'y2', state: 'UNSPENT' },
      ],
    );
    const result = diagnose(observation);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.balance.merged).toBe(6);
    expect(result.balance.mintVerified).toBe(6);
    expect(result.balance.doubleCounted).toBe(0);
    expect(result.balance.perRelay.map((entry) => entry.balance)).toEqual([6, 6]);
  });

  it('keeps mint truth isolated when two mints return different state for the same Y', () => {
    const shared = proof(4, 'same-y');
    const mintA = 'https://mint-a.example';
    const mintB = 'https://mint-b.example';
    const result = diagnose(
      observe(
        [
          relay(A, {
            tokens: [
              token('mint-a-token', [shared], { mint: mintA }),
              token('mint-b-token', [shared], { mint: mintB }),
            ],
          }),
        ],
        [
          { mint: mintA, y: shared.y, state: 'SPENT' },
          { mint: mintB, y: shared.y, state: 'UNSPENT' },
        ],
      ),
    );
    expect(result.balance.merged).toBe(8);
    expect(result.balance.ghost).toBe(4);
    expect(result.balance.mintVerified).toBe(4);
    expect(result.findings.filter((finding) => finding.code === 'GHOST_TOKEN')).toHaveLength(1);
  });
});

describe('diagnose: divergence codes', () => {
  it('RELAY_PARTITION when one relay misses a live token event', () => {
    const t1 = token('e1', [proof(2, 'y1')], { seenOn: [A] });
    const result = diagnose(
      observe([relay(A, { tokens: [t1] }), relay(B)], [{ mint: MINT, y: 'y1', state: 'UNSPENT' }]),
    );
    expect(result.findings.map((finding) => finding.code)).toContain('RELAY_PARTITION');
    const finding = result.findings.find((entry) => entry.code === 'RELAY_PARTITION');
    expect(finding?.severity).toBe('warning');
    expect(result.balance.perRelay).toEqual([
      { url: A, status: 'ok', balance: 2 },
      { url: B, status: 'ok', balance: 0 },
    ]);
  });

  it('GHOST_TOKEN for live events carrying SPENT proofs, at risk = spent part', () => {
    const t1 = token('e1', [proof(2, 'y1'), proof(4, 'y2')], { seenOn: [A, B] });
    const result = diagnose(
      observe(
        [relay(A, { tokens: [t1] }), relay(B, { tokens: [t1] })],
        [
          { mint: MINT, y: 'y1', state: 'SPENT' },
          { mint: MINT, y: 'y2', state: 'UNSPENT' },
        ],
      ),
    );
    const finding = result.findings.find((entry) => entry.code === 'GHOST_TOKEN');
    expect(finding?.severity).toBe('error');
    expect(finding?.amountAtRisk).toBe(2);
    expect(finding?.ys).toEqual(['y1']);
    expect(result.balance.ghost).toBe(2);
    expect(result.balance.mintVerified).toBe(4);
    expect(result.ok).toBe(false);
  });

  it('ORPHANED_PROOFS for UNSPENT proofs no live event references', () => {
    const t1 = token('e1', [proof(8, 'y1')], { seenOn: [A, B] });
    const result = diagnose(
      observe(
        [
          relay(A, { tokens: [t1], deletions: [del('d1', ['e1'], [A])] }),
          relay(B, { tokens: [t1], deletions: [del('d1', ['e1'], [B])] }),
        ],
        [{ mint: MINT, y: 'y1', state: 'UNSPENT' }],
      ),
    );
    const finding = result.findings.find((entry) => entry.code === 'ORPHANED_PROOFS');
    expect(finding?.severity).toBe('error');
    expect(finding?.amountAtRisk).toBe(8);
    expect(result.balance.orphanedUnspent).toBe(8);
    expect(result.balance.mintVerified).toBe(8);
  });

  it('does not flag orphans that are legitimately SPENT', () => {
    const t1 = token('e1', [proof(8, 'y1')], { seenOn: [A] });
    const result = diagnose(
      observe(
        [relay(A, { tokens: [t1], deletions: [del('d1', ['e1'], [A])] })],
        [{ mint: MINT, y: 'y1', state: 'SPENT' }],
      ),
    );
    expect(result.findings.map((finding) => finding.code)).not.toContain('ORPHANED_PROOFS');
  });

  it('DEL_CHAIN_BREAK when a rolled-over event stays live elsewhere', () => {
    const old = token('e1', [proof(4, 'y1'), proof(8, 'y2')], { seenOn: [B] });
    const rolled = token('e2', [proof(8, 'y2')], { del: ['e1'], seenOn: [A] });
    const result = diagnose(
      observe(
        [
          relay(A, { tokens: [rolled], deletions: [del('d1', ['e1'], [A])] }),
          relay(B, { tokens: [old] }),
        ],
        [
          { mint: MINT, y: 'y1', state: 'SPENT' },
          { mint: MINT, y: 'y2', state: 'UNSPENT' },
        ],
      ),
    );
    const finding = result.findings.find((entry) => entry.code === 'DEL_CHAIN_BREAK');
    expect(finding?.severity).toBe('error');
    expect(finding?.relays).toEqual([B]);
    expect(result.balance.doubleCounted).toBe(8);
    expect(result.balance.naiveMerged).toBe(20);
    expect(result.balance.merged).toBe(8);
    expect(result.findings.some((entry) => entry.code === 'DELETION_NOT_PROPAGATED')).toBe(false);
  });

  it('DELETION_NOT_PROPAGATED when a plain deletion missed a relay', () => {
    const t1 = token('e1', [proof(2, 'y1')], { seenOn: [A, B] });
    const t2 = token('e2', [proof(4, 'y2')], { seenOn: [A, B] });
    const result = diagnose(
      observe(
        [
          relay(A, { tokens: [t1, t2], deletions: [del('d1', ['e2'], [A])] }),
          relay(B, { tokens: [t1, t2] }),
        ],
        [
          { mint: MINT, y: 'y1', state: 'UNSPENT' },
          { mint: MINT, y: 'y2', state: 'SPENT' },
        ],
      ),
    );
    const finding = result.findings.find((entry) => entry.code === 'DELETION_NOT_PROPAGATED');
    expect(finding?.severity).toBe('warning');
    expect(finding?.eventIds).toEqual(['d1', 'e2']);
    // Plain deletions that did not propagate must not escalate to DEL_CHAIN_BREAK.
    expect(result.findings.map((entry) => entry.code)).not.toContain('DEL_CHAIN_BREAK');
    expect(result.ok).toBe(true);
  });

  it('does not emit HISTORY_GAP for a healthy rollover whose destroyed predecessor is pruned', () => {
    // e1 spent into e2; relays keep the deletion of e1 and the live e2, plus a
    // kind:7376 that references both. destroyed predecessors must not read as gaps.
    const rolled = token('e2', [proof(8, 'y2')], { del: ['e1'], seenOn: [A, B] });
    const result = diagnose(
      observe(
        [
          relay(A, {
            tokens: [rolled],
            deletions: [del('d1', ['e1'], [A])],
            history: [
              {
                eventId: 'h1',
                createdAt: 1_700_000_200,
                direction: 'out',
                amount: 4,
                unit: 'sat',
                created: ['e2'],
                destroyed: ['e1'],
                redeemed: [],
                seenOn: [A],
              },
            ],
          }),
          relay(B, {
            tokens: [rolled],
            deletions: [del('d1', ['e1'], [B])],
          }),
        ],
        [{ mint: MINT, y: 'y2', state: 'UNSPENT' }],
      ),
    );
    expect(result.findings.map((entry) => entry.code)).not.toContain('HISTORY_GAP');
    expect(result.ok).toBe(true);
  });

  it('WALLET_EVENT_FORK when relays serve different wallet versions', () => {
    const result = diagnose(
      observe(
        [
          relay(A, { wallet: [wallet('w2', 1_700_000_500, [A])] }),
          relay(B, { wallet: [wallet('w1', 1_700_000_000, [B])] }),
        ],
        [],
      ),
    );
    const finding = result.findings.find((entry) => entry.code === 'WALLET_EVENT_FORK');
    expect(finding?.severity).toBe('error');
    expect(finding?.relays).toEqual([B]);
    expect(finding?.eventIds).toContain('w2');
  });

  it('WALLET_EVENT_FORK when every healthy relay serves no wallet event', () => {
    const result = diagnose(observe([relay(A, { wallet: [] }), relay(B, { wallet: [] })], []));
    const finding = result.findings.find((entry) => entry.code === 'WALLET_EVENT_FORK');
    expect(finding?.severity).toBe('error');
    expect(finding?.relays).toEqual([A, B]);
    expect(finding?.eventIds).toEqual([]);
    expect(finding?.summary).toMatch(/no kind:17375 wallet event/u);
  });

  it('HISTORY_GAP for history entries referencing unknown token events', () => {
    const result = diagnose(
      observe(
        [
          relay(A, {
            history: [
              {
                eventId: 'h1',
                createdAt: 1_700_000_200,
                direction: 'out',
                amount: 4,
                unit: 'sat',
                created: ['e-missing'],
                destroyed: [],
                redeemed: [],
                seenOn: [A],
              },
            ],
          }),
          relay(B),
        ],
        [],
      ),
    );
    const finding = result.findings.find((entry) => entry.code === 'HISTORY_GAP');
    expect(finding?.severity).toBe('info');
    expect(finding?.eventIds).toEqual(['e-missing']);
  });

  it('QUOTE_LIMBO for unexpired quote events, deterministic on now', () => {
    const quotes = [
      {
        eventId: 'q1',
        createdAt: 1_700_000_000,
        expiration: 1_700_100_000,
        mint: MINT,
        seenOn: [A],
      },
      {
        eventId: 'q2',
        createdAt: 1_700_000_000,
        expiration: 1_600_000_000,
        mint: MINT,
        seenOn: [A],
      },
    ];
    const result = diagnose(observe([relay(A, { quotes }), relay(B)], []), {
      now: 1_700_050_000,
    });
    const finding = result.findings.find((entry) => entry.code === 'QUOTE_LIMBO');
    expect(finding?.severity).toBe('info');
    expect(finding?.eventIds).toEqual(['q1']);
  });

  it('MALFORMED_EVENT escalates for wallet and token kinds', () => {
    const result = diagnose(
      observe(
        [
          relay(A, {
            malformed: [
              { eventId: 'x1', kind: 7375, reason: 'decryption_failed', seenOn: [A] },
              { eventId: 'x2', kind: 7376, reason: 'invalid_payload', seenOn: [A] },
            ],
          }),
          relay(B),
        ],
        [],
      ),
    );
    const malformed = result.findings.filter((entry) => entry.code === 'MALFORMED_EVENT');
    expect(malformed.map((entry) => entry.severity)).toEqual(['error', 'warning']);
    expect(result.ok).toBe(false);
  });
});
