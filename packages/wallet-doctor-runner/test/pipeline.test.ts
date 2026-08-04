import { describe, expect, it } from 'vitest';
import { captureDigest, type Nip60Capture } from '@cashu-fault-lab/wallet-doctor-contract';
import {
  checkCapture,
  compareCaptureEvidence,
  diagnoseCapture,
  planForDiagnosis,
} from '../src/index.js';

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
  const normalizedRelays = relays.map((relay) => ({
    ...relay,
    wallet: relay.wallet.map((event) => ({ ...event, seenOn: [relay.url] })),
    tokens: relay.tokens.map((event) => ({ ...event, seenOn: [relay.url] })),
    deletions: relay.deletions.map((event) => ({ ...event, seenOn: [relay.url] })),
    history: relay.history.map((event) => ({ ...event, seenOn: [relay.url] })),
    quotes: relay.quotes.map((event) => ({ ...event, seenOn: [relay.url] })),
    malformed: relay.malformed.map((event) => ({ ...event, seenOn: [relay.url] })),
  }));
  const bundle: Omit<Nip60Capture, 'digest'> = {
    schemaVersion: 2,
    capturedAt: '2026-08-03T12:00:00.000Z',
    subject: SUBJECT,
    observation: { subject: SUBJECT, relays: normalizedRelays, mint },
    relayEvidence: normalizedRelays.map((relay) => ({
      url: relay.url,
      status: relay.status,
      error: relay.error,
      eventIds: [
        ...relay.wallet,
        ...relay.tokens,
        ...relay.deletions,
        ...relay.history,
        ...relay.quotes,
        ...relay.malformed,
      ]
        .flatMap((event) => (event.eventId === null ? [] : [event.eventId]))
        .sort(),
    })),
    redaction: {
      proofSecretsDropped: true,
      encryptedContentsDropped: true,
      walletPrivateKeyDropped: true,
    },
  };
  return { ...bundle, digest: captureDigest(bundle) };
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
    expect(result.summary.integrityErrors).toEqual([]);
  });

  it('fails closed when mint truth is missing even if diagnosis alone looks healthy', () => {
    const token = {
      eventId: HEX('1'),
      createdAt: 1_700_000_000,
      mint: MINT,
      unit: 'sat',
      proofs: [{ keysetId: 'k', amount: 2, y: Y('1') }],
      del: [],
      seenOn: [A],
    };
    const capture = captureWith([relay(A, { tokens: [token] })], []);
    const result = checkCapture(capture);
    expect(result.ok).toBe(false);
    expect(result.summary.integrityErrors).toContain(`missing mint state for ${MINT} ${Y('1')}`);
  });

  it('fails closed instead of throwing when proof amount aggregates overflow', () => {
    const token = {
      eventId: HEX('1'),
      createdAt: 1_700_000_000,
      mint: MINT,
      unit: 'sat',
      proofs: [
        { keysetId: 'k', amount: Number.MAX_SAFE_INTEGER, y: Y('1') },
        { keysetId: 'k', amount: 1, y: Y('2') },
      ],
      del: [],
      seenOn: [A],
    };
    const capture = captureWith(
      [relay(A, { tokens: [token] })],
      [
        { mint: MINT, y: Y('1'), state: 'UNSPENT' },
        { mint: MINT, y: Y('2'), state: 'UNSPENT' },
      ],
    );
    const result = checkCapture(capture);
    expect(result.ok).toBe(false);
    expect(result.diagnosisArtifact).toBeNull();
    expect(result.summary.integrityErrors).toContain(
      'capture aggregate proof amount exceeds the safe integer limit',
    );
  });

  it('bounds integrity errors so a failed check artifact remains serializable', () => {
    const longMint = `https://${'a'.repeat(2040)}`;
    const token = {
      eventId: HEX('1'),
      createdAt: 1_700_000_000,
      mint: longMint,
      unit: 'sat',
      proofs: [{ keysetId: 'k', amount: 1, y: Y('1') }],
      del: [],
      seenOn: [A],
    };
    const capture = captureWith([relay(A, { tokens: [token] })], []);
    const result = checkCapture(capture);
    expect(result.ok).toBe(false);
    expect(result.summary.integrityErrors.every((error) => error.length <= 2048)).toBe(true);
  });

  it('bounds diagnosis summaries for captures with many maximum-length relay URLs', () => {
    const relays = Array.from({ length: 64 }, (_, index) => {
      const prefix = `wss://${index.toString().padStart(2, '0')}.`;
      const url = `${prefix}${'a'.repeat(2048 - prefix.length)}`;
      return relay(url, { wallet: [] });
    });
    const artifact = diagnoseCapture(captureWith(relays, []));
    expect(artifact.diagnosis.findings).toHaveLength(1);
    expect(artifact.diagnosis.findings[0]?.summary.length).toBeLessThanOrEqual(8192);
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

describe('compareCaptureEvidence', () => {
  it('detects a self-consistent capture that does not match an independent recapture', () => {
    const expected = captureWith([relay(A)], []);
    const live = captureWith([relay(A), relay(B)], []);
    expect(compareCaptureEvidence(expected, expected)).toEqual({ ok: true, errors: [] });
    const comparison = compareCaptureEvidence(expected, live);
    expect(comparison.ok).toBe(false);
    expect(comparison.errors).toContain('live relay evidence differs from the supplied capture');
  });
});
