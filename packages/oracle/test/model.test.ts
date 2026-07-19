import { describe, expect, it } from 'vitest';
import {
  applyObservation,
  assertQuiescentLiveness,
  assertSafety,
  emptyOracleModel,
  type Observation,
  type OracleModel,
} from '../src/index.js';

function model(observations: readonly Observation[]): OracleModel {
  return observations.reduce(applyObservation, emptyOracleModel());
}

const request = {
  type: 'request_observed',
  requestId: 'request-1',
  singleUse: true,
} as const;
const attempt = {
  type: 'delivery_attempted',
  requestId: 'request-1',
  deliveryId: 'delivery-1',
  payloadHash: 'payload-a',
  proofSetHash: 'proofs-a',
  transport: 'http',
} as const;

describe('independent sequential oracle', () => {
  it('accepts an idempotent settled history', () => {
    const settled = model([
      request,
      attempt,
      attempt,
      { ...attempt, transport: 'nostr' },
      { type: 'mint_proofs_state', proofSetHash: 'proofs-a', state: 'SPENT' },
      {
        type: 'receiver_settled',
        deliveryId: 'delivery-1',
        replacementPlanHash: 'plan-a',
      },
      {
        type: 'merchant_credited',
        creditId: 'credit-a',
        requestId: 'request-1',
        deliveryId: 'delivery-1',
        amount: 8,
        unit: 'sat',
      },
      {
        type: 'receipt_observed',
        requestId: 'request-1',
        deliveryId: 'delivery-1',
        payloadHash: 'payload-a',
        status: 'settled',
        detailCode: 'settled',
        version: 2,
        amount: 8,
        unit: 'sat',
      },
    ]);

    expect(() => assertSafety(settled)).not.toThrow();
    expect(() => assertQuiescentLiveness(settled)).not.toThrow();
    expect(settled.deliveries.get('delivery-1')?.transports).toEqual(new Set(['http', 'nostr']));
  });

  it('detects two durable credits for one delivery', () => {
    const unsafe = model([
      request,
      attempt,
      {
        type: 'merchant_credited',
        creditId: 'credit-a',
        requestId: 'request-1',
        deliveryId: 'delivery-1',
        amount: 8,
        unit: 'sat',
      },
      {
        type: 'merchant_credited',
        creditId: 'credit-b',
        requestId: 'request-1',
        deliveryId: 'delivery-1',
        amount: 8,
        unit: 'sat',
      },
    ]);

    expect(() => assertSafety(unsafe)).toThrowError(/one credit/i);
  });

  it('detects two owners for one proof set', () => {
    const unsafe = model([request, attempt, { ...attempt, deliveryId: 'delivery-2' }]);
    expect(() => assertSafety(unsafe)).toThrowError(/unique owner/i);
  });

  it('detects more than one mint redemption start for a delivery', () => {
    const redemption = {
      type: 'redemption_started',
      deliveryId: 'delivery-1',
      proofSetHash: 'proofs-a',
    } as unknown as Observation;
    const unsafe = model([request, attempt, redemption, redemption]);

    expect(() => assertSafety(unsafe)).toThrowError(/redemption.*once/i);
  });

  it('detects delivery identity mutation', () => {
    const unsafe = model([request, attempt, { ...attempt, payloadHash: 'payload-b' }]);
    expect(() => assertSafety(unsafe)).toThrowError(/immutable/i);
  });

  it('requires recovered outputs and one credit for settled receipts', () => {
    const unsafe = model([
      request,
      attempt,
      {
        type: 'receipt_observed',
        requestId: 'request-1',
        deliveryId: 'delivery-1',
        payloadHash: 'payload-a',
        status: 'settled',
        detailCode: 'settled',
        version: 1,
        amount: 8,
        unit: 'sat',
      },
    ]);
    expect(() => assertSafety(unsafe)).toThrowError(/settled receipt/i);
  });

  it('binds every credit to a known delivery identity', () => {
    const unsafe = model([
      request,
      attempt,
      {
        type: 'receiver_settled',
        deliveryId: 'delivery-1',
        replacementPlanHash: 'plan-a',
      },
      {
        type: 'merchant_credited',
        creditId: 'credit-a',
        requestId: 'request-2',
        deliveryId: 'delivery-1',
        amount: 8,
        unit: 'sat',
      },
    ]);
    expect(() => assertSafety(unsafe)).toThrowError(/credit.*identity/i);
  });

  it('rejects invalid credited amounts', () => {
    const unsafe = model([
      request,
      attempt,
      {
        type: 'receiver_settled',
        deliveryId: 'delivery-1',
        replacementPlanHash: 'plan-a',
      },
      {
        type: 'merchant_credited',
        creditId: 'credit-a',
        requestId: 'request-1',
        deliveryId: 'delivery-1',
        amount: -1,
        unit: 'sat',
      },
    ]);
    expect(() => assertSafety(unsafe)).toThrowError(/credit.*amount/i);
  });

  it('forbids rejection after proofs may have been consumed', () => {
    const unsafe = model([
      request,
      attempt,
      { type: 'mint_proofs_state', proofSetHash: 'proofs-a', state: 'SPENT' },
      {
        type: 'receipt_observed',
        requestId: 'request-1',
        deliveryId: 'delivery-1',
        payloadHash: 'payload-a',
        status: 'rejected',
        detailCode: 'invalid',
        version: 2,
        amount: 8,
        unit: 'sat',
      },
    ]);
    expect(() => assertSafety(unsafe)).toThrowError(/reject.*consum/i);
  });

  it('allows explicit recovery-blocked state at quiescence', () => {
    const blocked = model([
      request,
      attempt,
      { type: 'mint_proofs_state', proofSetHash: 'proofs-a', state: 'PENDING' },
      {
        type: 'receipt_observed',
        requestId: 'request-1',
        deliveryId: 'delivery-1',
        payloadHash: 'payload-a',
        status: 'processing',
        detailCode: 'recovery_blocked',
        version: 3,
        amount: 8,
        unit: 'sat',
      },
    ]);
    expect(() => assertSafety(blocked)).not.toThrow();
    expect(() => assertQuiescentLiveness(blocked)).not.toThrow();
  });

  it('detects non-quiescent processing without recovery evidence', () => {
    expect(() => assertQuiescentLiveness(model([request, attempt]))).toThrowError(/quiescent/i);
  });
});
