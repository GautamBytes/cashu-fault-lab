import type { ProtocolId } from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import { createExactSwapPlan, replacementPlanHash } from '../src/adapters/swap-plan.js';

const deliveryId = 'EBESExQVFhcYGRobHB0eHw' as ProtocolId;

describe('exact swap plan', () => {
  it('persists recovery data while serializing byte-stable NUT-03 request bytes', () => {
    const plan = createExactSwapPlan(
      {
        version: 1,
        deliveryId,
        mint: 'https://mint.example',
        unit: 'sat',
        expectedAmount: 8,
        inputProofs: [
          {
            amount: 8,
            id: '009a1f293253e41e',
            secret: 'input-secret',
            C: `02${'11'.repeat(32)}`,
            dleq: { e: '01', s: '02', r: '03' },
          },
        ],
        proofYs: [`02${'22'.repeat(32)}`],
      },
      {
        keysetId: '009a1f293253e41e',
        inputFeePpk: 0,
        preparedAt: 1_784_399_400,
        outputs: [
          {
            amount: 8,
            id: '009a1f293253e41e',
            B_: `03${'33'.repeat(32)}`,
            secret: 'c2VjcmV0LW91dHB1dA',
            blindingFactor: '44'.repeat(32),
          },
        ],
        recovery: {
          nut09: true,
          nut19Replay: true,
          nut19ReplayUntil: 1_784_399_700,
        },
      },
    );

    expect(plan.outputs[0]).toMatchObject({
      secret: 'c2VjcmV0LW91dHB1dA',
      blindingFactor: '44'.repeat(32),
    });
    expect(plan.serializedRequest).toBe(
      JSON.stringify({
        inputs: [
          {
            amount: 8,
            id: '009a1f293253e41e',
            secret: 'input-secret',
            C: `02${'11'.repeat(32)}`,
          },
        ],
        outputs: [
          {
            amount: 8,
            id: '009a1f293253e41e',
            B_: `03${'33'.repeat(32)}`,
          },
        ],
      }),
    );
    expect(plan.serializedRequest).not.toContain('c2VjcmV0LW91dHB1dA');
    expect(plan.serializedRequest).not.toContain('blindingFactor');
    expect(plan.serializedRequest).not.toContain('dleq');
    expect(replacementPlanHash(plan)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects output sums and keyset bindings that do not match the draft', () => {
    expect(() =>
      createExactSwapPlan(
        {
          version: 1,
          deliveryId,
          mint: 'https://mint.example',
          unit: 'sat',
          expectedAmount: 8,
          inputProofs: [],
          proofYs: [],
        },
        {
          keysetId: '009a1f293253e41e',
          inputFeePpk: 0,
          preparedAt: 1_784_399_400,
          outputs: [
            {
              amount: 7,
              id: 'other-keyset',
              B_: `03${'33'.repeat(32)}`,
              secret: 'c2VjcmV0',
              blindingFactor: '44'.repeat(32),
            },
          ],
          recovery: { nut09: true, nut19Replay: false, nut19ReplayUntil: null },
        },
      ),
    ).toThrowError(/output amount|keyset/i);
  });
});
