import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDeliveryPayload, parseDeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import {
  adapterCapabilitiesSchema,
  deliveryPayloadSchema,
  deliveryReceiptSchema,
  deliveryRequestSchema,
  scenarioResultSchema,
  validateAdapterRequest,
  validateAdapterResponse,
  validateDeliveryPayload,
  validateDeliveryReceipt,
  validateDeliveryRequest,
} from '../src/index.js';

interface ValidVector {
  readonly name: string;
  readonly now: number;
  readonly request: unknown;
  readonly payload: unknown;
  readonly receipt: unknown;
}

interface InvalidVector {
  readonly name: string;
  readonly kind: 'request' | 'payload' | 'receipt';
  readonly value: unknown;
  readonly error_code: string;
}

function fixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`../../../spec/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const validVectors = fixture<{ readonly vectors: readonly ValidVector[] }>(
  'vectors/delivery-v1-wire.json',
).vectors;
const invalidVectors = fixture<{ readonly vectors: readonly InvalidVector[] }>(
  'vectors/delivery-v1-invalid.json',
).vectors;

describe('normative delivery-v1 vectors', () => {
  it('keeps runtime schemas byte-for-structure aligned with published artifacts', () => {
    expect(deliveryRequestSchema).toEqual(fixture('schemas/delivery-request.schema.json'));
    expect(deliveryPayloadSchema).toEqual(fixture('schemas/delivery-payload.schema.json'));
    expect(deliveryReceiptSchema).toEqual(fixture('schemas/delivery-receipt.schema.json'));
    expect(adapterCapabilitiesSchema).toEqual(fixture('schemas/adapter-capabilities.schema.json'));
    expect(scenarioResultSchema).toEqual(fixture('schemas/scenario-result.schema.json'));
  });

  it.each(validVectors)('accepts $name', ({ now, request, payload, receipt }) => {
    expect(validateDeliveryRequest(request)).toEqual({ ok: true });
    expect(validateDeliveryPayload(payload)).toEqual({ ok: true });
    expect(validateDeliveryReceipt(receipt)).toEqual({ ok: true });
    expect(() => parseDeliveryPayload(payload, now)).not.toThrow();
    expect(() => parseDeliveryReceipt(receipt)).not.toThrow();
  });

  it.each(invalidVectors)('rejects $name with $error_code', ({ kind, value, error_code }) => {
    const result =
      kind === 'request'
        ? validateDeliveryRequest(value)
        : kind === 'payload'
          ? validateDeliveryPayload(value)
          : validateDeliveryReceipt(value);
    expect(result).toMatchObject({ ok: false, errorCode: error_code });

    if (kind === 'payload') {
      expect(() => parseDeliveryPayload(value, 1_784_399_400)).toThrow();
    }
    if (kind === 'receipt') {
      expect(() => parseDeliveryReceipt(value)).toThrow();
    }
  });
});

describe('adapter HTTP contract', () => {
  it('accepts every command request shape', () => {
    expect(validateAdapterRequest('reset', { seed: 'scenario-001' })).toEqual({ ok: true });
    expect(
      validateAdapterRequest('createRequest', {
        amount: 8,
        unit: 'sat',
        description: 'order-42',
        transports: ['http', 'nostr'],
        singleUse: true,
        expiresIn: 900,
      }),
    ).toEqual({ ok: true });
    expect(
      validateAdapterRequest('send', {
        request: 'creqAexample',
        deliveryId: 'EBESExQVFhcYGRobHB0eHw',
        memo: null,
      }),
    ).toEqual({ ok: true });
  });

  it('accepts every query/command response shape', () => {
    const receipt = validVectors[0]!.receipt;
    expect(
      validateAdapterResponse('capabilities', {
        implementation: 'memory-reference',
        version: '0.0.0',
        nuts: [2, 3, 7, 9, 18, 19],
        transports: ['http', 'nostr'],
        evidenceTier: 'T3',
      }),
    ).toEqual({ ok: true });
    expect(validateAdapterResponse('reset', { ok: true })).toEqual({ ok: true });
    expect(
      validateAdapterResponse('createRequest', {
        id: 'AAECAwQFBgcICQoLDA0ODw',
        raw: 'creqAexample',
        amount: 8,
        unit: 'sat',
        singleUse: true,
        expiresAt: 1784400300,
        transports: [{ type: 'post', target: 'https://merchant.example/v1/pay' }],
      }),
    ).toEqual({ ok: true });
    expect(validateAdapterResponse('send', receipt)).toEqual({ ok: true });
    expect(validateAdapterResponse('delivery', receipt)).toEqual({ ok: true });
    expect(
      validateAdapterResponse('ledger', [
        {
          requestId: 'AAECAwQFBgcICQoLDA0ODw',
          deliveryId: 'EBESExQVFhcYGRobHB0eHw',
          amount: 8,
          unit: 'sat',
          creditCount: 1,
          createdAt: 1784399401,
        },
      ]),
    ).toEqual({ ok: true });
    expect(
      validateAdapterResponse('proofs', [
        {
          deliveryId: 'EBESExQVFhcYGRobHB0eHw',
          proofSetHash: 'b'.repeat(64),
          inputYs: ['02' + '01'.repeat(32)],
          state: 'spent',
        },
      ]),
    ).toEqual({ ok: true });
  });

  it('rejects unknown fields and unsupported operations', () => {
    expect(validateAdapterRequest('reset', { seed: 'x', extra: true })).toMatchObject({
      ok: false,
      errorCode: 'SCHEMA_ADDITIONAL_PROPERTY',
    });
    expect(validateAdapterRequest('unknown' as 'reset', {})).toMatchObject({
      ok: false,
      errorCode: 'UNKNOWN_OPERATION',
    });
  });
});
