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

  test('accepts authenticated hash-only Lightning settlement evidence', () => {
    const meltOperation = createOperation({ ...operation, kind: 'melt' });
    const paid = {
      type: 'lightning_settlement_observed',
      operationId,
      evidenceHash: 'e'.repeat(64),
      provenance: 'lightning',
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
          provenance: 'adapter_claimed',
        }),
      ),
    ).toThrow('Lightning settlement evidence is invalid');
  });

  test('rejects malformed observation provenance', () => {
    const model = observe({ type: 'operation_observed', operation }, {
      type: 'request_dispatched',
      operationId,
      requestKind: 'mint',
      method: 'POST',
      path: '/v1/mint/bolt11',
      bodyHash: 'b'.repeat(64),
      provenance: 'untrusted',
    } as never);

    expect(() => assertLifecycleSafety(model)).toThrow('observation provenance is invalid');
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
  test('retains proof evidence when a later operation observes the same proof', () => {
    const receiveId = 'BBBBBBBBBBBBBBBBBBBBBA';
    const receive = createOperation({
      ...operation,
      operationId: receiveId,
      kind: 'receive',
      intentHash: 'b'.repeat(64),
    });
    const swap = createOperation({ ...operation, kind: 'swap' });
    const phases = (id: string): readonly LifecycleObservation[] => [
      { type: 'phase_observed', operationId: id, phase: 'prepared' },
      { type: 'phase_observed', operationId: id, phase: 'submitted' },
      { type: 'phase_observed', operationId: id, phase: 'succeeded' },
    ];
    const model = observe(
      { type: 'operation_observed', operation: receive },
      ...phases(receiveId),
      {
        type: 'request_dispatched',
        operationId: receiveId,
        requestKind: 'swap',
        method: 'POST',
        path: '/v1/swap',
        bodyHash: '3'.repeat(64),
      },
      {
        type: 'outputs_persisted',
        operationId: receiveId,
        outputPlanHash: '4'.repeat(64),
        amount: 10,
        unit: 'sat',
      },
      {
        type: 'proof_state_observed',
        operationId: receiveId,
        proofId: '5'.repeat(64),
        owner: 'wallet:alice',
        state: 'UNSPENT',
      },
      {
        type: 'value_moved',
        operationId: receiveId,
        effectId: 'receive_credit',
        unit: 'sat',
        amount: 10,
        from: 'external:fixture',
        to: 'wallet:alice:available',
      },
      { type: 'operation_observed', operation: swap },
      ...phases(operationId),
      {
        type: 'request_dispatched',
        operationId,
        requestKind: 'swap',
        method: 'POST',
        path: '/v1/swap',
        bodyHash: '6'.repeat(64),
      },
      {
        type: 'outputs_persisted',
        operationId,
        outputPlanHash: '7'.repeat(64),
        amount: 8,
        unit: 'sat',
      },
      {
        type: 'proof_state_observed',
        operationId,
        proofId: '5'.repeat(64),
        owner: 'wallet:alice',
        state: 'SPENT',
      },
      {
        type: 'value_moved',
        operationId,
        effectId: 'swap_reserve',
        unit: 'sat',
        amount: 8,
        from: 'wallet:alice:available',
        to: 'wallet:alice:reserved',
      },
      {
        type: 'value_moved',
        operationId,
        effectId: 'swap_release',
        unit: 'sat',
        amount: 8,
        from: 'wallet:alice:reserved',
        to: 'wallet:alice:available',
      },
    );

    expect(() => assertLifecycleQuiescence(model)).not.toThrow();
  });

  test('reconstructs legal phases through the core state machine', () => {
    const model = observe(
      { type: 'operation_observed', operation },
      { type: 'phase_observed', operationId, phase: 'prepared' },
      {
        type: 'request_dispatched',
        operationId,
        requestKind: 'mint',
        method: 'POST',
        path: '/v1/mint/bolt11',
        bodyHash: '3'.repeat(64),
      },
      { type: 'phase_observed', operationId, phase: 'submitted' },
      { type: 'phase_observed', operationId, phase: 'succeeded' },
      {
        type: 'mint_quote_observed',
        operationId,
        quoteHash: '4'.repeat(64),
        amountPaid: 64,
        amountIssued: 64,
        updatedAt: 1,
      },
      {
        type: 'outputs_persisted',
        operationId,
        outputPlanHash: '2'.repeat(64),
        amount: 64,
        unit: 'sat',
      },
      {
        type: 'value_moved',
        operationId,
        effectId: 'mint_issue_1',
        unit: 'sat',
        amount: 64,
        from: 'external:fixture',
        to: 'wallet:alice:available',
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

  test('does not let a succeeded mint pass without request, quote, and value evidence', () => {
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

    expect(() => assertLifecycleQuiescence(model)).toThrow('has no request evidence');
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

  test('accepts a quiescent melt with authenticated hash-only settlement evidence', () => {
    const meltOperation = createOperation({ ...operation, kind: 'melt' });
    const model = observe(
      { type: 'operation_observed', operation: meltOperation },
      {
        type: 'value_moved',
        operationId,
        effectId: 'opening',
        unit: 'sat',
        amount: 10,
        from: 'external:opening',
        to: 'wallet:alice:available',
        provenance: 'adapter_claimed',
      },
      { type: 'phase_observed', operationId, phase: 'prepared' },
      { type: 'phase_observed', operationId, phase: 'submitted' },
      { type: 'phase_observed', operationId, phase: 'succeeded' },
      {
        type: 'request_dispatched',
        operationId,
        requestKind: 'melt',
        method: 'POST',
        path: '/v1/melt/bolt11',
        bodyHash: '3'.repeat(64),
        provenance: 'adapter_claimed',
      },
      {
        type: 'proof_state_observed',
        operationId,
        proofId: '4'.repeat(64),
        owner: 'wallet:alice',
        state: 'SPENT',
        provenance: 'adapter_claimed',
      },
      {
        type: 'value_moved',
        operationId,
        effectId: 'melt_debit',
        unit: 'sat',
        amount: 6,
        from: 'wallet:alice:available',
        to: 'lightning:settlement',
        provenance: 'adapter_claimed',
      },
      {
        type: 'lightning_settlement_observed',
        operationId,
        evidenceHash: '5'.repeat(64),
        provenance: 'lightning',
      },
    );

    expect(() => assertLifecycleQuiescence(model)).not.toThrow();
  });

  test('accepts the HTTP runtime melt observation shape', () => {
    const meltOperation = createOperation({
      ...operation,
      kind: 'melt',
      intentHash: 'a'.repeat(64),
    });
    const model = observe(
      { type: 'operation_observed', operation: meltOperation },
      {
        type: 'value_moved',
        operationId,
        effectId: 'e41f0ecfa2789cfd65bcd14a0fa02a93def04c91780806e87',
        unit: 'sat',
        amount: 10,
        from: 'external:opening',
        to: 'wallet:cashu-ts:available',
        provenance: 'adapter_claimed',
      },
      { type: 'phase_observed', operationId, phase: 'prepared', provenance: 'adapter_claimed' },
      { type: 'phase_observed', operationId, phase: 'submitted', provenance: 'adapter_claimed' },
      { type: 'phase_observed', operationId, phase: 'succeeded', provenance: 'adapter_claimed' },
      {
        type: 'request_dispatched',
        operationId,
        requestKind: 'melt',
        method: 'POST',
        path: '/v1/melt/bolt11',
        bodyHash: 'b'.repeat(64),
        provenance: 'adapter_claimed',
      },
      {
        type: 'proof_state_observed',
        operationId,
        proofId: '1'.repeat(64),
        owner: 'wallet:cashu-ts',
        state: 'SPENT',
        provenance: 'adapter_claimed',
      },
      {
        type: 'value_moved',
        operationId,
        effectId: 'e33cfc2b971463aae9332fbedcf46734ec8cbbe7c02c1d252',
        unit: 'sat',
        amount: 6,
        from: 'wallet:cashu-ts:available',
        to: 'lightning:aaaaaaaaaaaaaaaa',
        provenance: 'adapter_claimed',
      },
      {
        type: 'lightning_settlement_observed',
        operationId,
        evidenceHash: 'f'.repeat(64),
        provenance: 'lightning',
      },
    );

    expect(() => assertLifecycleQuiescence(model)).not.toThrow();
  });

  test('rejects non-terminal operations after faults stop', () => {
    const model = observe({ type: 'operation_observed', operation });
    expect(() => assertLifecycleQuiescence(model)).toThrow('is not quiescent');
  });
});
