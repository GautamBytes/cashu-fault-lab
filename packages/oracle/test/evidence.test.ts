import { describe, expect, it } from 'vitest';
import {
  applyObservation,
  emptyOracleModel,
  evaluateInvariants,
  INVARIANT_REGISTRY,
  type InvariantId,
  type Observation,
} from '../src/index.js';

function model(observations: readonly Observation[]) {
  return observations.reduce(applyObservation, emptyOracleModel());
}

const observations: readonly Observation[] = [
  { type: 'request_observed', requestId: 'request-1', singleUse: true },
  {
    type: 'delivery_attempted',
    requestId: 'request-1',
    deliveryId: 'delivery-1',
    payloadHash: 'payload-a',
    proofSetHash: 'proofs-a',
    transport: 'http',
  },
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
];

function result(id: InvariantId) {
  const results = evaluateInvariants({
    model: model(observations),
    commands: [{ type: 'send' }, { type: 'assert_quiescent' }],
    history: observations.map((observation, index) => ({
      sequence: index,
      phase: 'observation',
      event: observation.type,
      data: observation,
    })),
    metadata: {
      scenarioId: 'settled-payment',
      seed: 'seed-1',
      componentVersions: { oracle: '0.0.0' },
    },
  });
  const selected = results.find((candidate) => candidate.id === id);
  if (selected === undefined) throw new Error(`Missing invariant result: ${id}`);
  return selected;
}

describe('invariant evidence', () => {
  it('evaluates every registered invariant exactly once', () => {
    expect(INVARIANT_REGISTRY).toHaveLength(18);
    expect(
      evaluateInvariants({
        model: model(observations),
        commands: [],
        history: [],
      }).map((item) => item.id),
    ).toEqual(INVARIANT_REGISTRY.map((item) => item.id));
  });

  it('backs merchant-credit uniqueness with observed ledger evidence', () => {
    expect(result('at-most-one-merchant-credit-per-delivery')).toMatchObject({
      status: 'passed',
      confidence: 'observed',
      evidence: [expect.objectContaining({ source: 'ledger' })],
    });
  });

  it('does not promote missing mint proof evidence into a pass', () => {
    expect(result('independent-mint-evidence')).toMatchObject({
      status: 'not_observable',
      reason: expect.stringContaining('mint proof evidence'),
    });
  });

  it('marks crash recovery not applicable without a restart command', () => {
    expect(result('crash-recovery')).toMatchObject({
      status: 'not_applicable',
    });
  });
});
