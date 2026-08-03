import { describe, expect, it } from 'vitest';
import type { Nip60Capture } from '@cashu-fault-lab/wallet-doctor-contract';
import { checkCapture, diagnoseCapture, planForDiagnosis } from '../src/index.js';

const A = 'ws://127.0.0.1:4430';
const B = 'ws://127.0.0.1:4431';
const MINT = 'http://127.0.0.1:3338';
const SUBJECT = 'ab'.repeat(32);
const HEX = (char: string): string => char.repeat(64);
const Y = (n: string): string => '02' + n.padEnd(64, '0').slice(0, 64);

function captureWith(
  relays: Nip60Capture['observation']['relays'],
  mint: Nip60Capture['observation']['mint'],
): Nip60Capture {
  return {
    schemaVersion: 1,
    capturedAt: '2026-08-03T12:00:00.000Z',
    digest: 'sha256:' + '0'.repeat(64),
    subject: SUBJECT,
    observation: { subject: SUBJECT, relays, mint },
    rawRelays: [],
    redaction: { proofSecretsDropped: true },
  };
}

function relay(url: string, events: Partial<Nip60Capture['observation']['relays'][number]> = {}) {
  return {
    url,
    status: 'ok' as const,
    error: null,
    wallet: [
      {
        eventId: HEX('f'),
        createdAt: 1_700_000_000,
        mints: [MINT],
        hasP2pkKey: true,
        seenOn: [url],
      },
    ],
    tokens: [],
    deletions: [],
    history: [],
    quotes: [],
    malformed: [],
    ...events,
  };
}

describe('checkCapture', () => {
  it('passes a healthy capture with no plan', () => {
    const token = {
      eventId: HEX('1'),
      createdAt: 1_700_000_000,
      mint: MINT,
      unit: 'sat',
      proofs: [{ keysetId: 'k', amount: 2, y: Y('1') }],
      del: [],
      seenOn: [A, B],
    };
    const capture = captureWith(
      [relay(A, { tokens: [token] }), relay(B, { tokens: [token] })],
      [{ mint: MINT, y: Y('1'), state: 'UNSPENT' }],
    );
    const result = checkCapture(capture);
    expect(result.ok).toBe(true);
    expect(result.planArtifact).toBeNull();
    expect(result.summary.errorFindings).toBe(0);
  });

  it('fails when every relay is unreachable (incomplete evidence is not a pass)', () => {
    const capture = captureWith(
      [
        {
          url: A,
          status: 'error',
          error: 'connection failed',
          wallet: [],
          tokens: [],
          deletions: [],
          history: [],
          quotes: [],
          malformed: [],
        },
        {
          url: B,
          status: 'error',
          error: 'connection failed',
          wallet: [],
          tokens: [],
          deletions: [],
          history: [],
          quotes: [],
          malformed: [],
        },
      ],
      [],
    );
    const result = checkCapture(capture);
    expect(result.ok).toBe(false);
    expect(result.summary.failedRelays).toBe(2);
    expect(result.summary.errorFindings).toBe(0);
    expect(result.summary.codes).toEqual([]);
  });

  it('emits diagnosis codes in sorted order for stable CI comparisons', () => {
    const tokenA = {
      eventId: HEX('a'),
      createdAt: 1_700_000_000,
      mint: MINT,
      unit: 'sat',
      proofs: [{ keysetId: 'k', amount: 2, y: Y('a') }],
      del: [],
      seenOn: [A],
    };
    const capture = captureWith(
      [
        relay(A, {
          tokens: [tokenA],
          wallet: [
            {
              eventId: HEX('f'),
              createdAt: 1_700_000_500,
              mints: [MINT],
              hasP2pkKey: true,
              seenOn: [A],
            },
          ],
        }),
        relay(B, {
          wallet: [
            {
              eventId: HEX('e'),
              createdAt: 1_700_000_000,
              mints: [MINT],
              hasP2pkKey: true,
              seenOn: [B],
            },
          ],
        }),
      ],
      [{ mint: MINT, y: Y('a'), state: 'UNSPENT' }],
    );
    const result = checkCapture(capture);
    // RELAY_PARTITION (warning) + WALLET_EVENT_FORK (error) — alphabetical codes.
    expect(result.summary.codes).toEqual(['RELAY_PARTITION', 'WALLET_EVENT_FORK']);
  });

  it('fails on a del-chain break and attaches a safe repair plan', () => {
    const oldToken = {
      eventId: HEX('2'),
      createdAt: 1_700_000_000,
      mint: MINT,
      unit: 'sat',
      proofs: [
        { keysetId: 'k', amount: 4, y: Y('2') },
        { keysetId: 'k', amount: 8, y: Y('3') },
      ],
      del: [],
      seenOn: [B],
    };
    const rolledToken = {
      eventId: HEX('3'),
      createdAt: 1_700_000_100,
      mint: MINT,
      unit: 'sat',
      proofs: [{ keysetId: 'k', amount: 8, y: Y('3') }],
      del: [HEX('2')],
      seenOn: [A],
    };
    const deletion = {
      eventId: HEX('4'),
      createdAt: 1_700_000_200,
      targets: [HEX('2')],
      kinds: [7375],
      seenOn: [A],
    };
    const capture = captureWith(
      [
        relay(A, { tokens: [rolledToken], deletions: [deletion] }),
        relay(B, { tokens: [oldToken] }),
      ],
      [
        { mint: MINT, y: Y('2'), state: 'SPENT' },
        { mint: MINT, y: Y('3'), state: 'UNSPENT' },
      ],
    );
    const result = checkCapture(capture);
    expect(result.ok).toBe(false);
    expect(result.summary.codes).toContain('DEL_CHAIN_BREAK');
    expect(result.summary.doubleCounted).toBe(8);
    expect(result.planArtifact).not.toBeNull();
    expect(result.planArtifact?.safety.ok).toBe(true);
    expect(result.planArtifact?.plan.steps.map((step) => step.action)).toEqual([
      'publish_rollover',
      'delete_events',
    ]);
  });
});

describe('diagnoseCapture + planForDiagnosis artifacts', () => {
  it('binds artifacts to the capture digest', () => {
    const capture = captureWith([relay(A)], []);
    const diagnosis = diagnoseCapture(capture);
    expect(diagnosis.kind).toBe('nip60-diagnosis');
    expect(diagnosis.generatedFrom).toBe(capture.digest);
    const plan = planForDiagnosis(capture, diagnosis);
    expect(plan.kind).toBe('nip60-repair-plan');
    expect(plan.generatedFrom).toBe(capture.digest);
    expect(plan.plan.captureDigest).toBe(capture.digest);
  });
});
