import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { NIP60_CAPTURE_SCHEMA, validateNip60Capture } from '../src/index.js';

const HEX = (char: string): string => char.repeat(64);
const Y = '02' + 'ab'.repeat(32);
const MINT = 'http://127.0.0.1:3338';

function validCapture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
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
    rawRelays: [
      {
        url: 'ws://127.0.0.1:4430',
        status: 'ok',
        error: null,
        events: [
          {
            id: HEX('2'),
            pubkey: HEX('a'),
            created_at: 1_700_000_000,
            kind: 7375,
            tags: [],
            content: 'encrypted',
            sig: 'ab'.repeat(64),
          },
        ],
      },
    ],
    redaction: { proofSecretsDropped: true },
  };
}

describe('validateNip60Capture', () => {
  it('accepts a fully populated valid bundle', () => {
    const result = validateNip60Capture(validCapture());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
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

  it('rejects additional properties', () => {
    const broken = validCapture();
    broken.extra = true;
    expect(validateNip60Capture(broken).ok).toBe(false);
  });
});

describe('spec schema drift', () => {
  it('spec/schemas/nip60-capture.schema.json matches the runtime schema', async () => {
    const specUrl = new URL('../../../spec/schemas/nip60-capture.schema.json', import.meta.url);
    const spec = JSON.parse(await readFile(specUrl, 'utf8')) as unknown;
    expect(spec).toEqual(JSON.parse(JSON.stringify(NIP60_CAPTURE_SCHEMA)));
  });
});
