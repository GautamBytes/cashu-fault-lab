import { describe, expect, it } from 'vitest';
import { assertReceiptTransition, parseProtocolId, type DeliveryReceipt } from '../src/index';

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

describe('assertReceiptTransition', () => {
  it('accepts an initial processing receipt and a later settled receipt', () => {
    const processing = receipt();
    const settled = receipt({ status: 'settled', statusVersion: 2, detailCode: 'settled' });

    expect(() => assertReceiptTransition(undefined, processing)).not.toThrow();
    expect(() => assertReceiptTransition(processing, settled)).not.toThrow();
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
