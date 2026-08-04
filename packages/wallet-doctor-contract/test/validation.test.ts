import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  NIP60_CAPTURE_SCHEMA,
  captureDigest,
  validateNip60Capture,
  verifyCaptureIntegrity,
} from '../src/index.js';

const HEX = (char: string): string => char.repeat(64);
const Y = '02' + 'ab'.repeat(32);
const MINT = 'http://127.0.0.1:3338';

function validCapture(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    capturedAt: '2026-08-03T12:00:00.000Z',
    digest: 'sha256:' + '0'.repeat(64),
    subject: HEX('a'),
    observation: {
      subject: HEX('a'),
      relays: [
        {
          url: 'ws://127.0.0.1:4430',
          status: 'ok',
          error: null,
          wallet: [
            {
              eventId: HEX('1'),
              createdAt: 1_700_000_000,
              mints: [MINT],
              hasP2pkKey: true,
              seenOn: ['ws://127.0.0.1:4430'],
            },
          ],
          tokens: [
            {
              eventId: HEX('2'),
              createdAt: 1_700_000_000,
              mint: MINT,
              unit: 'sat',
              proofs: [{ keysetId: '00ad268c4d1f5826', amount: 2, y: Y }],
              del: [],
              seenOn: ['ws://127.0.0.1:4430'],
            },
          ],
          deletions: [
            {
              eventId: HEX('3'),
              createdAt: 1_700_000_100,
              targets: [HEX('4')],
              kinds: [7375],
              seenOn: ['ws://127.0.0.1:4430'],
            },
          ],
          history: [
            {
              eventId: HEX('5'),
              createdAt: 1_700_000_200,
              direction: 'out',
              amount: 4,
              unit: 'sat',
              created: [HEX('2')],
              destroyed: [HEX('4')],
              redeemed: [],
              seenOn: ['ws://127.0.0.1:4430'],
            },
          ],
          quotes: [
            {
              eventId: HEX('6'),
              createdAt: 1_700_000_300,
              expiration: 1_700_100_000,
              mint: MINT,
              seenOn: ['ws://127.0.0.1:4430'],
            },
          ],
          malformed: [
            {
              eventId: HEX('7'),
              kind: 7375,
              reason: 'decryption_failed',
              seenOn: ['ws://127.0.0.1:4430'],
            },
          ],
        },
        {
          url: 'ws://127.0.0.1:4431',
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
      mint: [{ mint: MINT, y: Y, state: 'UNSPENT' }],
    },
    relayEvidence: [
      {
        url: 'ws://127.0.0.1:4430',
        status: 'ok',
        error: null,
        eventIds: [HEX('1'), HEX('2'), HEX('3'), HEX('5'), HEX('6'), HEX('7')],
      },
      {
        url: 'ws://127.0.0.1:4431',
        status: 'error',
        error: 'connection failed',
        eventIds: [],
      },
    ],
    redaction: {
      proofSecretsDropped: true,
      encryptedContentsDropped: true,
      walletPrivateKeyDropped: true,
    },
  };
}

function withDigest(): Record<string, unknown> {
  const capture = validCapture();
  const { digest: _digest, ...bundle } = capture;
  capture.digest = captureDigest(bundle as never);
  return capture;
}

describe('validateNip60Capture', () => {
  it('accepts a fully populated valid bundle', () => {
    const result = validateNip60Capture(withDigest());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts NUT-02 v2 keyset IDs in capture artifacts', () => {
    const capture = withDigest();
    const relays = (
      capture.observation as {
        relays: Array<{ tokens: Array<{ proofs: Array<{ keysetId: string }> }> }>;
      }
    ).relays;
    const proof = relays[0]?.tokens[0]?.proofs[0];
    if (proof === undefined) throw new Error('expected proof fixture');
    proof.keysetId = `01${'a'.repeat(64)}`;
    const { digest: _digest, ...bundle } = capture;
    capture.digest = captureDigest(bundle as never);
    expect(validateNip60Capture(capture).ok).toBe(true);
  });

  it('rejects schema violations with readable errors', () => {
    const broken = validCapture();
    (broken.observation as Record<string, unknown>).mint = [{ mint: MINT, y: 'zz', state: 'GONE' }];
    const result = validateNip60Capture(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects bundles that keep proof secrets', () => {
    const broken = validCapture();
    broken.redaction = { proofSecretsDropped: false };
    expect(validateNip60Capture(broken).ok).toBe(false);
  });

  it('fails integrity verification when the digest is forged', () => {
    const result = verifyCaptureIntegrity(validCapture());
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('capture digest does not match its canonical contents');
  });

  it('fails integrity verification when NUT-07 truth is incomplete', () => {
    const capture = withDigest();
    (capture.observation as { mint: unknown[] }).mint = [];
    const { digest: _digest, ...bundle } = capture;
    capture.digest = captureDigest(bundle as never);
    const result = verifyCaptureIntegrity(capture);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`missing mint state for ${MINT} ${Y}`);
  });

  it('fails integrity verification when relay evidence and observations diverge', () => {
    const capture = withDigest();
    (capture.relayEvidence as Array<{ eventIds: string[] }>)[0]?.eventIds.pop();
    const { digest: _digest, ...bundle } = capture;
    capture.digest = captureDigest(bundle as never);
    const result = verifyCaptureIntegrity(capture);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('relay evidence is missing event'))).toBe(
      true,
    );
  });

  it('requires a one-to-one URL mapping between relay observations and evidence', () => {
    const capture = withDigest();
    const relays = (capture.observation as { relays: Array<{ url: string }> }).relays;
    if (relays[1] === undefined) throw new Error('expected second relay');
    relays[1].url = relays[0]?.url ?? '';
    const { digest: _digest, ...bundle } = capture;
    capture.digest = captureDigest(bundle as never);
    const result = verifyCaptureIntegrity(capture);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('relay observations contain duplicate urls');
    expect(result.errors).toContain(
      'relay evidence URL ws://127.0.0.1:4431 has no matching observation',
    );
  });

  it('rejects additional properties', () => {
    const broken = validCapture();
    broken.extra = true;
    expect(validateNip60Capture(broken).ok).toBe(false);
  });

  it('bounds aggregate mint truth to ten thousand proofs', () => {
    const broken = withDigest();
    (broken.observation as { mint: unknown[] }).mint = Array.from({ length: 10_001 }, () => ({
      mint: MINT,
      y: Y,
      state: 'UNSPENT',
    }));
    expect(validateNip60Capture(broken).ok).toBe(false);
  });

  it('preflights aggregate event occurrences before full validation and hashing', () => {
    const broken = withDigest();
    const relays = (broken.observation as { relays: Array<{ tokens: unknown[] }> }).relays;
    const token = relays[0]?.tokens[0];
    if (token === undefined) throw new Error('expected token fixture');
    if (relays[0] === undefined) throw new Error('expected relay fixture');
    relays[0].tokens = Array.from({ length: 10_001 }, () => token);
    const result = verifyCaptureIntegrity(broken);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('capture contains more than 10000 event occurrences');
  });
});

describe('spec schema drift', () => {
  it('spec/schemas/nip60-capture.schema.json matches the runtime schema', async () => {
    const specUrl = new URL('../../../spec/schemas/nip60-capture.schema.json', import.meta.url);
    const spec = JSON.parse(await readFile(specUrl, 'utf8')) as unknown;
    expect(spec).toEqual(JSON.parse(JSON.stringify(NIP60_CAPTURE_SCHEMA)));
  });
});
