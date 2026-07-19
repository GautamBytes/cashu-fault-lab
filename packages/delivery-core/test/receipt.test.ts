import { describe, expect, it } from 'vitest';
import {
  assertReceiptTransition,
  DeliveryValidationError,
  mergeObservedReceipt,
  parseDeliveryReceipt,
  parseProtocolId,
  serializeDeliveryReceipt,
  type DeliveryReceipt,
} from '../src/index';

const requestId = parseProtocolId('AAECAwQFBgcICQoLDA0ODw');
const deliveryId = parseProtocolId('EBESExQVFhcYGRobHB0eHw');

function receipt(overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return {
    profile: 'cashu-delivery-v1',
    requestId,
    deliveryId,
    payloadHash: 'a'.repeat(64),
    status: 'processing',
    statusVersion: 1,
    mint: 'https://mint.example',
    unit: 'sat',
    amount: 100,
    detailCode: 'redeeming',
    ...overrides,
  };
}

function wireReceipt(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    profile: 'cashu-delivery-v1',
    request_id: requestId,
    delivery_id: deliveryId,
    payload_hash: 'a'.repeat(64),
    status: 'processing',
    status_version: 1,
    mint: 'https://mint.example',
    unit: 'sat',
    amount: 100,
    detail_code: 'redeeming',
    ...overrides,
  };
}

describe('delivery receipt wire codec', () => {
  it('round-trips the normative snake_case receipt shape', () => {
    const wire = wireReceipt();

    expect(serializeDeliveryReceipt(parseDeliveryReceipt(wire))).toEqual(wire);
  });

  it('rejects inherited-property status names with a validation error', () => {
    expect(() => parseDeliveryReceipt(wireReceipt({ status: 'toString' }))).toThrowError(
      DeliveryValidationError,
    );
  });

  it('rejects non-string wire fields', () => {
    expect(() => parseDeliveryReceipt(wireReceipt({ unit: { length: 3 } }))).toThrowError(
      DeliveryValidationError,
    );
  });

  it('accepts an unknown non-empty detail code as diagnostic data', () => {
    expect(parseDeliveryReceipt(wireReceipt({ detail_code: 'mint_delayed' })).detailCode).toBe(
      'mint_delayed',
    );
  });
});

describe('assertReceiptTransition', () => {
  it('accepts an initial processing receipt and a later settled receipt', () => {
    const processing = receipt();
    const settled = receipt({ status: 'settled', statusVersion: 2, detailCode: 'settled' });

    expect(() => assertReceiptTransition(undefined, processing)).not.toThrow();
    expect(() => assertReceiptTransition(processing, settled)).not.toThrow();
  });

  it('requires the first receiver receipt to start at version one', () => {
    expect(() => assertReceiptTransition(undefined, receipt({ statusVersion: 2 }))).toThrowError(
      /start at version 1/i,
    );
  });

  it('accepts an exact duplicate without incrementing the status version', () => {
    const processing = receipt();
    expect(() => assertReceiptTransition(processing, { ...processing })).not.toThrow();
  });

  it('rejects a stale receipt after settlement', () => {
    const settled = receipt({ status: 'settled', statusVersion: 2, detailCode: 'settled' });
    expect(() => assertReceiptTransition(settled, receipt())).toThrowError(/regress/i);
  });

  it('rejects different content at the same status version', () => {
    expect(() =>
      assertReceiptTransition(receipt(), receipt({ detailCode: 'recovery_blocked' })),
    ).toThrowError(/same version/i);
  });

  it('rejects a receiver mutation that skips a status version', () => {
    expect(() =>
      assertReceiptTransition(
        receipt(),
        receipt({ status: 'settled', statusVersion: 3, detailCode: 'settled' }),
      ),
    ).toThrowError(/increment/i);
  });

  it('rejects a version bump without a status or detail transition', () => {
    expect(() => assertReceiptTransition(receipt(), receipt({ statusVersion: 2 }))).toThrowError(
      /status or detail/i,
    );
  });

  it('does not convert a recovery-blocked receipt into a rejection', () => {
    expect(() =>
      assertReceiptTransition(
        receipt({ detailCode: 'recovery_blocked' }),
        receipt({ status: 'rejected', statusVersion: 2, detailCode: 'invalid' }),
      ),
    ).toThrowError(/consumed/i);
  });

  it('rejects a changed request, delivery, or payload identity', () => {
    expect(() =>
      assertReceiptTransition(
        receipt(),
        receipt({ payloadHash: 'b'.repeat(64), statusVersion: 2 }),
      ),
    ).toThrowError(/identity/i);
  });

  it.each([
    receipt({ statusVersion: 0 }),
    receipt({ mint: 'HTTPS://Mint.Example/' }),
    receipt({ status: 'settled', detailCode: 'redeeming' }),
    receipt({ status: 'processing', detailCode: 'settled' }),
  ])('rejects an invalid receipt', (invalidReceipt) => {
    expect(() => assertReceiptTransition(undefined, invalidReceipt)).toThrowError(/invalid/i);
  });
});

describe('mergeObservedReceipt', () => {
  it('accepts a newer observation even when intermediate versions were missed', () => {
    const newer = receipt({ status: 'settled', statusVersion: 4, detailCode: 'settled' });

    expect(mergeObservedReceipt(receipt(), newer)).toBe(newer);
  });

  it('ignores a stale observation instead of downgrading sender state', () => {
    const current = receipt({ status: 'settled', statusVersion: 4, detailCode: 'settled' });

    expect(mergeObservedReceipt(current, receipt())).toBe(current);
  });

  it('treats an exact duplicate as idempotent', () => {
    const current = receipt();
    expect(mergeObservedReceipt(current, { ...current })).toBe(current);
  });

  it('rejects different content at one observed status version', () => {
    expect(() =>
      mergeObservedReceipt(receipt(), receipt({ detailCode: 'recovery_blocked' })),
    ).toThrowError(/same version/i);
  });
});
