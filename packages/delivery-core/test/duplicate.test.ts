import { describe, expect, it } from 'vitest';
import { classifyDelivery, type ExistingDeliveryBinding } from '../src/index';

const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const otherDeliveryId = 'ICEiIyQlJicoKSorLC0uLw';

function binding(overrides: Partial<ExistingDeliveryBinding> = {}): ExistingDeliveryBinding {
  return {
    requestId,
    deliveryId,
    payloadHash: 'a'.repeat(64),
    proofSetHash: 'b'.repeat(64),
    holdsProofClaim: true,
    holdsRequestReservation: true,
    ...overrides,
  };
}

describe('delivery duplicate classification', () => {
  it('classifies a new delivery', () => {
    expect(classifyDelivery([], binding(), true)).toBe('new');
  });

  it('classifies same delivery and payload as a duplicate', () => {
    expect(classifyDelivery([binding()], binding(), true)).toBe('duplicate');
  });

  it('rejects same delivery ID bound to another payload', () => {
    expect(classifyDelivery([binding()], binding({ payloadHash: 'c'.repeat(64) }), true)).toBe(
      'delivery_conflict',
    );
  });

  it('rejects inconsistent proof binding under the same delivery and payload', () => {
    expect(classifyDelivery([binding()], binding({ proofSetHash: 'c'.repeat(64) }), true)).toBe(
      'delivery_conflict',
    );
  });

  it('rejects a claimed proof set under another delivery ID', () => {
    expect(classifyDelivery([binding()], binding({ deliveryId: otherDeliveryId }), false)).toBe(
      'proof_conflict',
    );
  });

  it('rejects another active delivery for a single-use request', () => {
    expect(
      classifyDelivery(
        [binding({ proofSetHash: 'd'.repeat(64) })],
        binding({ deliveryId: otherDeliveryId, proofSetHash: 'e'.repeat(64) }),
        true,
      ),
    ).toBe('single_use_conflict');
  });

  it('allows released proof and request reservations to be reused', () => {
    expect(
      classifyDelivery(
        [binding({ holdsProofClaim: false, holdsRequestReservation: false })],
        binding({ deliveryId: otherDeliveryId }),
        true,
      ),
    ).toBe('new');
  });
});
