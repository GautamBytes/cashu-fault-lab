import { createOperation } from '@cashu-fault-lab/wallet-lifecycle-core';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import {
  applyLifecycleObservation,
  assertLifecycleSafety,
  emptyLifecycleModel,
  evaluateLifecycleModel,
  type LifecycleObservation,
} from '../src/index.js';

test('repeating any valid funding observation is idempotent', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 1, max: 20 }),
      (amount, repeats) => {
        const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
        const operation = createOperation({
          operationId,
          kind: 'mint',
          mint: 'http://127.0.0.1:3338',
          unit: 'sat',
          intentHash: 'a'.repeat(64),
        });
        const effect: LifecycleObservation = {
          type: 'value_moved',
          operationId,
          effectId: 'funding_1',
          unit: 'sat',
          amount,
          from: 'external:fixture',
          to: 'wallet:alice:available',
        };
        const observations: LifecycleObservation[] = [
          { type: 'operation_observed', operation },
          ...Array.from({ length: repeats }, () => effect),
        ];
        const model = observations.reduce(applyLifecycleObservation, emptyLifecycleModel());

        expect(() => assertLifecycleSafety(model)).not.toThrow();
        expect(evaluateLifecycleModel(model).balances.get('sat\0wallet:alice:available')).toBe(
          amount,
        );
      },
    ),
  );
});

test('an unfunded wallet can never produce a valid debit', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1_000_000 }), (amount) => {
      const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
      const operation = createOperation({
        operationId,
        kind: 'melt',
        mint: 'http://127.0.0.1:3338',
        unit: 'sat',
        intentHash: 'a'.repeat(64),
      });
      const observations: LifecycleObservation[] = [
        { type: 'operation_observed', operation },
        {
          type: 'value_moved',
          operationId,
          effectId: 'unfunded_melt',
          unit: 'sat',
          amount,
          from: 'wallet:alice:available',
          to: 'lightning:fixture',
        },
      ];
      const model = observations.reduce(applyLifecycleObservation, emptyLifecycleModel());

      expect(() => assertLifecycleSafety(model)).toThrow(
        'wallet:alice:available cannot become negative',
      );
    }),
  );
});
