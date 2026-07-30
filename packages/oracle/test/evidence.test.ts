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

  it('preserves adapter-claimed provenance instead of upgrading it to observation', () => {
    const selected = evaluateInvariants({
      model: model(observations),
      commands: [{ type: 'send' }],
      history: observations.map((observation, index) => ({
        sequence: index,
        phase: 'observation',
        event: observation.type,
        data: observation,
      })),
      observationConfidence: 'adapter_claimed',
    }).find((candidate) => candidate.id === 'at-most-one-merchant-credit-per-delivery');

    expect(selected).toMatchObject({ status: 'passed', confidence: 'adapter_claimed' });
  });

  it('downgrades a derived invariant when one referenced source is adapter-claimed', () => {
    const selected = evaluateInvariants({
      model: model([...observations, observations[1]!]),
      commands: [{ type: 'configure_fault', target: 'http' }, { type: 'send' }, { type: 'send' }],
      history: observations.map((observation, index) => ({
        sequence: index,
        phase: 'observation',
        event: observation.type,
        data: observation,
      })),
      sourceConfidence: {
        timeline: 'observed',
        receipt: 'adapter_claimed',
        ledger: 'observed',
      },
    }).find((candidate) => candidate.id === 'retry-convergence');

    expect(selected).toMatchObject({
      status: 'passed',
      confidence: 'adapter_claimed',
      evidence: [expect.objectContaining({ source: 'receipt' })],
    });
  });

  it('preserves derived confidence when every referenced source is observed', () => {
    const selected = evaluateInvariants({
      model: model([...observations, observations[1]!]),
      commands: [{ type: 'configure_fault', target: 'http' }, { type: 'send' }, { type: 'send' }],
      history: observations.map((observation, index) => ({
        sequence: index,
        phase: 'observation',
        event: observation.type,
        data: observation,
      })),
      sourceConfidence: {
        timeline: 'observed',
        receipt: 'observed',
        ledger: 'observed',
      },
    }).find((candidate) => candidate.id === 'retry-convergence');

    expect(selected).toMatchObject({ status: 'passed', confidence: 'derived' });
  });

  it('does not derive proof-set exclusivity from adapter-claimed proof identities', () => {
    const selected = evaluateInvariants({
      model: model(observations),
      commands: [{ type: 'send' }],
      history: observations.map((observation, index) => ({
        sequence: index,
        phase: 'observation',
        event: observation.type,
        data: observation,
      })),
      sourceConfidence: {
        timeline: 'observed',
        proofs: 'adapter_claimed',
      },
    }).find((candidate) => candidate.id === 'proof-set-exclusivity');

    expect(selected).toMatchObject({ status: 'passed', confidence: 'adapter_claimed' });
  });

  it('requires at least one ordered history entry for reproducibility', () => {
    const selected = evaluateInvariants({
      model: model([]),
      commands: [],
      history: [],
      metadata: {
        scenarioId: 'empty-run',
        seed: 'seed-1',
        componentVersions: { oracle: '0.0.0' },
      },
    }).find((candidate) => candidate.id === 'reproducibility');

    expect(selected).toMatchObject({ status: 'not_observable' });
  });

  it('marks crash recovery not applicable without a restart command', () => {
    expect(result('crash-recovery')).toMatchObject({
      status: 'not_applicable',
    });
  });

  it('proves no false rejection after an ambiguous receiver crash settles', () => {
    const selected = evaluateInvariants({
      model: model([
        ...observations,
        { type: 'mint_proofs_state', proofSetHash: 'proofs-a', state: 'SPENT' },
      ]),
      commands: [
        {
          type: 'arm_crash',
          component: 'receiver',
          boundary: 'receiver_after_mint_request_before_response',
        },
      ],
      history: [],
    }).find((candidate) => candidate.id === 'no-false-rejection-after-possible-consumption');

    expect(selected).toMatchObject({
      status: 'passed',
      evidence: expect.arrayContaining([
        expect.objectContaining({ source: 'receipt' }),
        expect.objectContaining({ source: 'proofs' }),
      ]),
    });
  });

  it('fails a rejected delivery whose proofs may have been consumed', () => {
    const rejected = observations.map((observation) =>
      observation.type === 'receipt_observed'
        ? { ...observation, status: 'rejected' as const, detailCode: 'mint_unavailable' }
        : observation,
    );
    const selected = evaluateInvariants({
      model: model([
        ...rejected,
        { type: 'mint_proofs_state', proofSetHash: 'proofs-a', state: 'SPENT' },
      ]),
      commands: [
        {
          type: 'arm_crash',
          component: 'receiver',
          boundary: 'receiver_after_mint_response_before_output_persistence',
        },
      ],
      history: [],
    }).find((candidate) => candidate.id === 'no-false-rejection-after-possible-consumption');

    expect(selected).toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/rejected proofs.*consumed/i),
    });
  });

  it('fails a rejection after an ambiguous crash even when the latest proof snapshot is unspent', () => {
    const rejected = observations.map((observation) =>
      observation.type === 'receipt_observed'
        ? { ...observation, status: 'rejected' as const, detailCode: 'mint_unavailable' }
        : observation,
    );
    const selected = evaluateInvariants({
      model: model([
        ...rejected,
        { type: 'mint_proofs_state', proofSetHash: 'proofs-a', state: 'UNSPENT' },
      ]),
      commands: [
        {
          type: 'arm_crash',
          component: 'receiver',
          boundary: 'receiver_after_mint_request_before_response',
        },
      ],
      history: [],
    }).find((candidate) => candidate.id === 'no-false-rejection-after-possible-consumption');

    expect(selected).toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/rejected.*ambiguous mint request/i),
    });
  });

  it('does not use unrelated mint proof evidence to qualify a rejected delivery', () => {
    const rejected = observations.map((observation) =>
      observation.type === 'receipt_observed'
        ? { ...observation, status: 'rejected' as const, detailCode: 'expired' }
        : observation,
    );
    const selected = evaluateInvariants({
      model: model([
        ...rejected,
        { type: 'mint_proofs_state', proofSetHash: 'proofs-other', state: 'UNSPENT' },
      ]),
      commands: [{ type: 'send' }, { type: 'assert_quiescent' }],
      history: [],
    }).find((candidate) => candidate.id === 'no-false-rejection-after-possible-consumption');

    expect(selected).toMatchObject({
      status: 'not_observable',
      reason: expect.stringMatching(/rejected delivery/i),
    });
  });

  it('treats a rejection before delivery binding as pre-consumption', () => {
    const selected = evaluateInvariants({
      model: model([
        { type: 'request_observed', requestId: 'request-1', singleUse: true },
        {
          type: 'receipt_observed',
          requestId: 'request-1',
          deliveryId: 'delivery-rejected',
          payloadHash: 'payload-rejected',
          status: 'rejected',
          detailCode: 'conflict',
          version: 1,
          amount: 8,
          unit: 'sat',
        },
        { type: 'mint_proofs_state', proofSetHash: 'proofs-other', state: 'SPENT' },
      ]),
      commands: [{ type: 'send' }, { type: 'assert_quiescent' }],
      history: [],
    }).find((candidate) => candidate.id === 'no-false-rejection-after-possible-consumption');

    expect(selected).toMatchObject({
      status: 'not_applicable',
      reason: expect.stringMatching(/before delivery binding/i),
    });
  });

  it('keeps no-false-rejection not applicable without an ambiguous crash or rejection', () => {
    expect(result('no-false-rejection-after-possible-consumption')).toMatchObject({
      status: 'not_applicable',
    });
  });

  it('does not classify security-only HTTP faults as retry scenarios', () => {
    const selected = evaluateInvariants({
      model: model([]),
      commands: [
        {
          type: 'configure_fault',
          target: 'http',
          rule: { kind: 'redirect_to_attacker' },
        },
      ],
      history: [],
    }).find((candidate) => candidate.id === 'retry-convergence');

    expect(selected).toMatchObject({ status: 'not_applicable' });
  });

  it('treats an observed pre-redemption rejection as having no redemption to count', () => {
    const results = evaluateInvariants({
      model: model([
        observations[0]!,
        observations[1]!,
        { type: 'mint_proofs_state', proofSetHash: 'proofs-a', state: 'UNSPENT' },
        {
          type: 'receipt_observed',
          requestId: 'request-1',
          deliveryId: 'delivery-1',
          payloadHash: 'payload-a',
          status: 'rejected',
          detailCode: 'expired',
          version: 1,
          amount: 8,
          unit: 'sat',
        },
      ]),
      commands: [{ type: 'send' }, { type: 'assert_quiescent' }],
      history: [],
    });

    for (const id of [
      'at-most-once-redemption-start',
      'at-most-one-merchant-credit-per-request',
      'at-most-one-merchant-credit-per-delivery',
      'independent-ledger-evidence',
    ] as const) {
      expect(results.find((candidate) => candidate.id === id)).toMatchObject({
        status: 'not_applicable',
      });
    }
  });
});
