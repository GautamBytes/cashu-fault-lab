import { createOperation } from '@cashu-fault-lab/wallet-lifecycle-core';
import { describe, expect, test } from 'vitest';
import {
  applyLifecycleObservation,
  assertLifecycleQuiescence,
  assertLifecycleSafety,
  emptyLifecycleModel,
  evaluateLifecycleModel,
  type LifecycleModel,
  type LifecycleObservation,
} from '../src/index.js';

const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
const operation = createOperation({
  operationId,
  kind: 'mint',
  mint: 'http://127.0.0.1:3338',
  unit: 'sat',
  intentHash: 'a'.repeat(64),
});

function observe(...observations: readonly LifecycleObservation[]): LifecycleModel {
  return observations.reduce(applyLifecycleObservation, emptyLifecycleModel());
}

describe('lifecycle value safety', () => {
  test('treats an identical value effect as idempotent', () => {
    const funding: LifecycleObservation = {
      type: 'value_moved',
      operationId,
      effectId: 'funding_1',
      unit: 'sat',
      amount: 64,
      from: 'external:fixture',
      to: 'wallet:alice:available',
    };
    const model = observe({ type: 'operation_observed', operation }, funding, funding);

    expect(() => assertLifecycleSafety(model)).not.toThrow();
    expect(evaluateLifecycleModel(model).balances.get('sat\0wallet:alice:available')).toBe(64);
  });

  test('rejects a reused effect ID with different economic data', () => {
    const model = observe(
      { type: 'operation_observed', operation },
      {
        type: 'value_moved',
        operationId,
        effectId: 'funding_1',
        unit: 'sat',
        amount: 64,
        from: 'external:fixture',
        to: 'wallet:alice:available',
      },
      {
        type: 'value_moved',
        operationId,
        effectId: 'funding_1',
        unit: 'sat',
        amount: 65,
        from: 'external:fixture',
        to: 'wallet:alice:available',
      },
    );

    expect(() => assertLifecycleSafety(model)).toThrow('effect funding_1 conflicts');
  });

  test('rejects internal typed accounts becoming negative', () => {
    for (const [index, account] of [
      'wallet:alice:available',
      'wallet:alice:reserved',
      'wallet:alice:recoverable',
      'transfer:handoff',
      'receiver:bob',
      'lightning:settlement',
      'fee:mint:input',
      'fee:lightning:routing',
    ].entries()) {
      const model = observe(
        { type: 'operation_observed', operation },
        {
          type: 'value_moved',
          operationId,
          effectId: `overspend_${index}`,
          unit: 'sat',
          amount: 1,
          from: account,
          to: 'external:fixture',
        },
      );

      expect(() => assertLifecycleSafety(model)).toThrow(`${account} cannot become negative`);
    }
  });

  test('rejects invalid amounts, self transfers, and malformed accounts', () => {
    const base = { type: 'operation_observed', operation } as const;
    const invalid = [
      { amount: 0, from: 'external:fixture', to: 'wallet:alice:available' },
      { amount: -1, from: 'external:fixture', to: 'wallet:alice:available' },
      { amount: 1.5, from: 'external:fixture', to: 'wallet:alice:available' },
      { amount: 1, from: 'wallet:alice:available', to: 'wallet:alice:available' },
      { amount: 1, from: 'unknown', to: 'wallet:alice:available' },
    ];

    for (const [index, candidate] of invalid.entries()) {
      const model = observe(base, {
        type: 'value_moved',
        operationId,
        effectId: `invalid_${index}`,
        unit: 'sat',
        ...candidate,
      });
      expect(() => assertLifecycleSafety(model)).toThrow('value movement');
    }
  });
});

describe('lifecycle protocol evidence safety', () => {
  test('requires repeated effecting requests to use the exact digest', () => {
    const first = {
      type: 'request_dispatched',
      operationId,
      requestKind: 'mint',
      method: 'POST',
      path: '/v1/mint/bolt11',
      bodyHash: 'b'.repeat(64),
    } as const;

    expect(() =>
      assertLifecycleSafety(observe({ type: 'operation_observed', operation }, first, first)),
    ).not.toThrow();
    expect(() =>
      assertLifecycleSafety(
        observe({ type: 'operation_observed', operation }, first, {
          ...first,
          bodyHash: 'c'.repeat(64),
        }),
      ),
    ).toThrow('request digest changed');
  });

  test('rejects mint quote regressions and over-issuance', () => {
    const quote = {
      type: 'mint_quote_observed',
      operationId,
      quoteHash: 'd'.repeat(64),
      amountPaid: 64,
      amountIssued: 32,
      updatedAt: 10,
    } as const;

    expect(() =>
      assertLifecycleSafety(
        observe({ type: 'operation_observed', operation }, quote, {
          ...quote,
          amountIssued: 16,
          updatedAt: 11,
        }),
      ),
    ).toThrow('mint quote regressed');
    expect(() =>
      assertLifecycleSafety(
        observe(
          { type: 'operation_observed', operation },
          {
            ...quote,
            amountPaid: 31,
          },
        ),
      ),
    ).toThrow('amount issued exceeds amount paid');
  });

  test('allows an identical Lightning settlement but rejects a second payment', () => {
    const meltOperation = createOperation({ ...operation, kind: 'melt' });
    const paid = {
      type: 'lightning_settlement_observed',
      operationId,
      invoiceHash: 'e'.repeat(64),
      paymentHash: 'f'.repeat(64),
      amount: 21,
      unit: 'sat',
    } as const;

    expect(() =>
      assertLifecycleSafety(
        observe({ type: 'operation_observed', operation: meltOperation }, paid, paid),
      ),
    ).not.toThrow();
    expect(() =>
      assertLifecycleSafety(
        observe({ type: 'operation_observed', operation: meltOperation }, paid, {
          ...paid,
          paymentHash: '0'.repeat(64),
        }),
      ),
    ).toThrow('Lightning invoice settled more than once');
  });

  test('rejects proof ownership changes and spent-state regressions', () => {
    const proof = {
      type: 'proof_state_observed',
      operationId,
      proofId: '1'.repeat(64),
      owner: 'wallet:alice',
      state: 'UNSPENT',
    } as const;
    expect(() =>
      assertLifecycleSafety(
        observe(
          { type: 'operation_observed', operation },
          proof,
          { ...proof, state: 'PENDING' },
          { ...proof, state: 'SPENT' },
        ),
      ),
    ).not.toThrow();
    expect(() =>
      assertLifecycleSafety(
        observe({ type: 'operation_observed', operation }, proof, {
          ...proof,
          owner: 'wallet:mallory',
        }),
      ),
    ).toThrow('proof owner changed');
    expect(() =>
      assertLifecycleSafety(
        observe({ type: 'operation_observed', operation }, { ...proof, state: 'SPENT' }, proof),
      ),
    ).toThrow('proof state regressed');
  });
});

describe('lifecycle phase and quiescence safety', () => {
  test('reconstructs legal phases through the core state machine', () => {
    const model = observe(
      { type: 'operation_observed', operation },
      { type: 'phase_observed', operationId, phase: 'prepared' },
      { type: 'phase_observed', operationId, phase: 'submitted' },
      { type: 'phase_observed', operationId, phase: 'succeeded' },
      {
        type: 'outputs_persisted',
        operationId,
        outputPlanHash: '2'.repeat(64),
        amount: 64,
        unit: 'sat',
      },
    );

    expect(() => assertLifecycleQuiescence(model)).not.toThrow();
  });

  test('requires output evidence for a succeeded mint', () => {
    const model = observe(
      { type: 'operation_observed', operation },
      { type: 'phase_observed', operationId, phase: 'prepared' },
      { type: 'phase_observed', operationId, phase: 'submitted' },
      { type: 'phase_observed', operationId, phase: 'succeeded' },
    );
    expect(() => assertLifecycleQuiescence(model)).toThrow('has no persisted outputs');
  });

  test('requires one settlement for a succeeded melt', () => {
    const meltOperation = createOperation({ ...operation, kind: 'melt' });
    const model = observe(
      { type: 'operation_observed', operation: meltOperation },
      { type: 'phase_observed', operationId, phase: 'prepared' },
      { type: 'phase_observed', operationId, phase: 'submitted' },
      { type: 'phase_observed', operationId, phase: 'succeeded' },
    );
    expect(() => assertLifecycleQuiescence(model)).toThrow('has no Lightning settlement');
  });

  test('rejects non-terminal operations after faults stop', () => {
    const model = observe({ type: 'operation_observed', operation });
    expect(() => assertLifecycleQuiescence(model)).toThrow('is not quiescent');
  });
});
