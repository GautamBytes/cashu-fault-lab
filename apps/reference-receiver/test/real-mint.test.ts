import type { ProtocolId } from '@cashu-fault-lab/delivery-core';
import { afterEach, describe, expect, it } from 'vitest';
import { CashuTsMintGateway, MintGatewayError } from '../src/index.js';
import { MockMintServer, mockKeysetId } from './mock-mint.js';

const deliveryId = 'EBESExQVFhcYGRobHB0eHw' as ProtocolId;
const servers: MockMintServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

function draft(mint: string) {
  return {
    version: 1 as const,
    deliveryId,
    mint,
    unit: 'sat',
    expectedAmount: 8,
    inputProofs: [
      {
        amount: 8,
        id: mockKeysetId,
        secret: 'input-secret',
        C: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      },
    ],
    proofYs: ['0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'],
  };
}

describe('CashuTsMintGateway NUT-03', () => {
  it('persists an exact plan, swaps it, and reconstructs replacement proofs', async () => {
    const mint = new MockMintServer({ nut09: true, nut19Ttl: null });
    servers.push(mint);
    await mint.start();
    const gateway = new CashuTsMintGateway({ now: () => 1_784_399_400 });

    const plan = await gateway.prepareSwap(draft(mint.url));
    const result = await gateway.swap(plan);

    expect(plan.keysetId).toBe(mockKeysetId);
    expect(plan.outputs).toHaveLength(1);
    expect(plan.serializedRequest).toBe(mint.swapBodies[0]);
    expect(result.replacementPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.replacementProofs).toHaveLength(1);
    expect(JSON.parse(result.replacementProofs[0]!)).toMatchObject({
      amount: 8,
      id: mockKeysetId,
    });
    expect(await gateway.proofStates(plan)).toEqual(['SPENT']);
  });

  it('classifies post-swap signature processing failure as possibly consumed', async () => {
    const mint = new MockMintServer({ nut09: true, nut19Ttl: null });
    servers.push(mint);
    await mint.start();
    const gateway = new CashuTsMintGateway({ now: () => 1_784_399_400 });
    const plan = await gateway.prepareSwap(draft(mint.url));
    mint.failNextKeys = true;

    await expect(gateway.swap(plan)).rejects.toMatchObject({
      name: MintGatewayError.name,
      mayHaveConsumedInputs: true,
    });
    expect(mint.swapCalls).toBe(1);
  });
});
