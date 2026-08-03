import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import {
  normalizeDeletionEvent,
  normalizeHistoryEvent,
  normalizeQuoteEvent,
  normalizeTokenPayload,
  normalizeWalletPayload,
  proofY,
} from '../src/index.js';

const SEEN = ['ws://127.0.0.1:4430'];

function fakeEvent(kind: number, content = ''): Event {
  const sk = generateSecretKey();
  return finalizeEvent({ kind, created_at: 1_700_000_000, tags: [], content }, sk);
}

describe('proofY', () => {
  it('computes the NUT-00 Y deterministically as compressed-point hex', () => {
    const y = proofY('unit-test-secret');
    expect(y).toMatch(/^0[23][0-9a-f]{64}$/u);
    expect(proofY('unit-test-secret')).toBe(y);
    expect(proofY('other-secret')).not.toBe(y);
  });
});

describe('normalizeTokenPayload', () => {
  it('drops secrets and keeps public y values', () => {
    const event = fakeEvent(7375);
    const result = normalizeTokenPayload(
      event,
      {
        mint: 'http://127.0.0.1:3338',
        proofs: [
          { id: '00ad268c4d1f5826', amount: 2, secret: 'secret-a' },
          { id: '00ad268c4d1f5826', amount: 4, secret: 'secret-b' },
        ],
        del: ['a'.repeat(64)],
      },
      SEEN,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.unit).toBe('sat');
    expect(result.view.proofs.map((proof) => proof.amount)).toEqual([2, 4]);
    expect(JSON.stringify(result.view)).not.toContain('secret-a');
    expect(result.view.del).toEqual(['a'.repeat(64)]);
  });

  it('rejects payloads without proofs or with bad amounts', () => {
    const event = fakeEvent(7375);
    expect(normalizeTokenPayload(event, { mint: 'http://m' }, SEEN).ok).toBe(false);
    expect(
      normalizeTokenPayload(
        event,
        { mint: 'http://m', proofs: [{ id: 'k', amount: 0, secret: 's' }] },
        SEEN,
      ).ok,
    ).toBe(false);
  });
});

describe('normalizeWalletPayload', () => {
  it('reads mints and the P2PK key presence flag only', () => {
    const event = fakeEvent(17375);
    const result = normalizeWalletPayload(
      event,
      [
        ['privkey', 'deadbeef'],
        ['mint', 'http://127.0.0.1:3338'],
        ['mint', 'http://127.0.0.1:8085'],
      ],
      SEEN,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.mints).toEqual(['http://127.0.0.1:3338', 'http://127.0.0.1:8085']);
    expect(result.view.hasP2pkKey).toBe(true);
    expect(JSON.stringify(result.view)).not.toContain('deadbeef');
  });

  it('flags wallet events without mints', () => {
    const result = normalizeWalletPayload(fakeEvent(17375), [['privkey', 'x']], SEEN);
    expect(result).toEqual({ ok: false, reason: 'wallet_without_mints' });
  });
});

describe('normalizeHistoryEvent', () => {
  it('merges encrypted markers with plaintext redeemed tags', () => {
    const sk = generateSecretKey();
    const event = finalizeEvent(
      {
        kind: 7376,
        created_at: 1_700_000_000,
        tags: [['e', 'c'.repeat(64), '', 'redeemed']],
        content: '',
      },
      sk,
    );
    const result = normalizeHistoryEvent(
      event,
      [
        ['direction', 'out'],
        ['amount', '4'],
        ['e', 'a'.repeat(64), '', 'destroyed'],
        ['e', 'b'.repeat(64), '', 'created'],
      ],
      SEEN,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.direction).toBe('out');
    expect(result.view.amount).toBe(4);
    expect(result.view.created).toEqual(['b'.repeat(64)]);
    expect(result.view.destroyed).toEqual(['a'.repeat(64)]);
    expect(result.view.redeemed).toEqual(['c'.repeat(64)]);
  });
});

describe('normalizeDeletionEvent', () => {
  it('collects e targets and k kinds', () => {
    const sk = generateSecretKey();
    const event = finalizeEvent(
      {
        kind: 5,
        created_at: 1_700_000_100,
        tags: [
          ['e', 'a'.repeat(64)],
          ['e', 'b'.repeat(64)],
          ['k', '7375'],
        ],
        content: '',
      },
      sk,
    );
    const view = normalizeDeletionEvent(event, SEEN);
    expect(view.targets).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(view.kinds).toEqual([7375]);
  });
});

describe('normalizeQuoteEvent', () => {
  it('reads expiration and mint tags', () => {
    const sk = generateSecretKey();
    const event = finalizeEvent(
      {
        kind: 7374,
        created_at: 1_700_000_000,
        tags: [
          ['expiration', '1700100000'],
          ['mint', 'http://127.0.0.1:3338'],
        ],
        content: 'encrypted-quote-id',
      },
      sk,
    );
    const result = normalizeQuoteEvent(event, SEEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.expiration).toBe(1_700_100_000);
    expect(result.view.mint).toBe('http://127.0.0.1:3338');
  });
});

describe('getPublicKey interop', () => {
  it('matches the subject used in captures', () => {
    const sk = generateSecretKey();
    expect(getPublicKey(sk)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
