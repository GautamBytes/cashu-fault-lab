import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyObservation,
  assertQuiescentLiveness,
  assertSafety,
  emptyOracleModel,
  type Observation,
} from '../src/index.js';

const safeHistoryArbitrary = fc
  .record({
    requestId: fc.stringMatching(/^[a-z]{1,12}$/),
    deliveryId: fc.stringMatching(/^[a-z]{1,12}$/),
    payloadHash: fc.stringMatching(/^[a-f]{1,16}$/),
    proofSetHash: fc.stringMatching(/^[a-f]{1,16}$/),
    amount: fc.integer({ min: 0, max: 1_000_000 }),
    singleUse: fc.boolean(),
    terminal: fc.constantFrom<'settled' | 'rejected'>('settled', 'rejected'),
    duplicateCount: fc.integer({ min: 0, max: 8 }),
    crossTransport: fc.boolean(),
  })
  .map((sample): readonly Observation[] => {
    const attempt = {
      type: 'delivery_attempted',
      requestId: sample.requestId,
      deliveryId: sample.deliveryId,
      payloadHash: sample.payloadHash,
      proofSetHash: sample.proofSetHash,
      transport: 'http',
    } as const;
    const history: Observation[] = [
      {
        type: 'request_observed',
        requestId: sample.requestId,
        singleUse: sample.singleUse,
      },
      attempt,
      ...Array.from({ length: sample.duplicateCount }, () => attempt),
    ];
    if (sample.crossTransport) history.push({ ...attempt, transport: 'nostr' });

    if (sample.terminal === 'settled') {
      history.push(
        { type: 'mint_proofs_state', proofSetHash: sample.proofSetHash, state: 'SPENT' },
        {
          type: 'receiver_settled',
          deliveryId: sample.deliveryId,
          replacementPlanHash: `plan-${sample.deliveryId}`,
        },
        {
          type: 'merchant_credited',
          creditId: `credit-${sample.deliveryId}`,
          requestId: sample.requestId,
          deliveryId: sample.deliveryId,
          amount: sample.amount,
          unit: 'sat',
        },
        {
          type: 'receipt_observed',
          requestId: sample.requestId,
          deliveryId: sample.deliveryId,
          payloadHash: sample.payloadHash,
          status: 'settled',
          detailCode: 'settled',
          version: 2,
          amount: sample.amount,
          unit: 'sat',
        },
      );
    } else {
      history.push(
        { type: 'mint_proofs_state', proofSetHash: sample.proofSetHash, state: 'UNSPENT' },
        {
          type: 'receipt_observed',
          requestId: sample.requestId,
          deliveryId: sample.deliveryId,
          payloadHash: sample.payloadHash,
          status: 'rejected',
          detailCode: 'invalid',
          version: 1,
          amount: sample.amount,
          unit: 'sat',
        },
      );
    }
    return history;
  });

describe('oracle properties', () => {
  it('accepts 1,000 generated idempotent histories', () => {
    fc.assert(
      fc.property(safeHistoryArbitrary, (history) => {
        const model = history.reduce(applyObservation, emptyOracleModel());
        expect(() => assertSafety(model)).not.toThrow();
        expect(() => assertQuiescentLiveness(model)).not.toThrow();
      }),
      { numRuns: 1_000, seed: 0x1d3f_2026 },
    );
  });

  it('has no dependency on the implementation under test', () => {
    for (const name of ['model.ts', 'commands.ts', 'invariants.ts', 'index.ts']) {
      const path = fileURLToPath(new URL(`../src/${name}`, import.meta.url));
      expect(readFileSync(path, 'utf8')).not.toContain('@cashu-fault-lab/delivery-core');
    }
  });
});
