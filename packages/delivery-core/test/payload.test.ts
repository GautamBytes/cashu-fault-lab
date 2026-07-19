import { describe, expect, it } from 'vitest';
import {
  DeliveryValidationError,
  parseDeliveryPayload,
  parseDeliveryPayloadJson,
  serializeDeliveryPayload,
} from '../src/index';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';

function wirePayload(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: requestId,
    memo: 'order-1',
    mint: 'HTTPS://Mint.Example:443/',
    unit: 'sat',
    proofs: [{ amount: 1, id: '00aa', secret: 'secret-a', C: '02aa' }],
    delivery: {
      v: 1,
      id: deliveryId,
      created_at: now,
      expires_at: now + 900,
    },
    ...overrides,
  };
}

describe('delivery payload codec', () => {
  it('parses, normalizes, and serializes the version-one wire shape', () => {
    const payload = parseDeliveryPayload(wirePayload(), now);

    expect(payload).toMatchObject({
      id: requestId,
      memo: 'order-1',
      mint: 'https://mint.example',
      unit: 'sat',
      delivery: {
        version: 1,
        id: deliveryId,
        createdAt: now,
        expiresAt: now + 900,
      },
    });
    expect(parseDeliveryPayloadJson(serializeDeliveryPayload(payload), now)).toEqual(payload);
  });

  it('maps an omitted memo to null', () => {
    const { memo: _memo, ...withoutMemo } = wirePayload();
    expect(parseDeliveryPayload(withoutMemo, now).memo).toBeNull();
  });

  it('accepts delivery within receiver clock skew', () => {
    const payload = wirePayload({
      delivery: { v: 1, id: deliveryId, created_at: now - 900, expires_at: now - 60 },
    });
    expect(parseDeliveryPayload(payload, now).delivery.expiresAt).toBe(now - 60);
  });

  it.each([
    ['request ID', wirePayload({ id: 'bad' })],
    [
      'delivery version',
      wirePayload({
        delivery: { v: 2, id: deliveryId, created_at: now, expires_at: now + 900 },
      }),
    ],
    [
      'delivery ID',
      wirePayload({
        delivery: { v: 1, id: 'bad', created_at: now, expires_at: now + 900 },
      }),
    ],
    [
      'timestamp order',
      wirePayload({
        delivery: { v: 1, id: deliveryId, created_at: now, expires_at: now },
      }),
    ],
    [
      '24 hour window',
      wirePayload({
        delivery: { v: 1, id: deliveryId, created_at: now, expires_at: now + 86_401 },
      }),
    ],
    [
      'future creation',
      wirePayload({
        delivery: { v: 1, id: deliveryId, created_at: now + 61, expires_at: now + 900 },
      }),
    ],
    [
      'expired delivery',
      wirePayload({
        delivery: { v: 1, id: deliveryId, created_at: now - 900, expires_at: now - 61 },
      }),
    ],
    ['proof count', wirePayload({ proofs: Array.from({ length: 257 }, () => ({})) })],
  ])('rejects invalid %s', (_label, value) => {
    expect(() => parseDeliveryPayload(value, now)).toThrowError(DeliveryValidationError);
  });

  it('rejects encoded JSON larger than 65,536 bytes', () => {
    const encoded = Buffer.from(JSON.stringify(wirePayload({ memo: 'x'.repeat(65_536) })));
    expect(() => parseDeliveryPayloadJson(encoded, now)).toThrowError(/65,536/i);
  });

  it('rejects malformed JSON and invalid UTF-8', () => {
    expect(() => parseDeliveryPayloadJson(Buffer.from('{'), now)).toThrowError(/JSON/i);
    expect(() => parseDeliveryPayloadJson(Uint8Array.from([0xc3, 0x28]), now)).toThrowError(
      /UTF-8/i,
    );
  });

  it('rejects sparse proof arrays', () => {
    expect(() => parseDeliveryPayload(wirePayload({ proofs: Array(1) }), now)).toThrowError(
      /holes/i,
    );
  });

  it('rejects unknown top-level and delivery fields', () => {
    expect(() => parseDeliveryPayload(wirePayload({ unexpected: true }), now)).toThrowError(
      /unknown/i,
    );
    expect(() =>
      parseDeliveryPayload(
        wirePayload({
          delivery: {
            v: 1,
            id: deliveryId,
            created_at: now,
            expires_at: now + 900,
            unexpected: true,
          },
        }),
        now,
      ),
    ).toThrowError(/unknown/i);
  });
});
