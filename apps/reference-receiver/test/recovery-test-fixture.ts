import type { ProtocolId } from '@cashu-fault-lab/delivery-core';
import { mockKeysetId } from './mock-mint.js';

export function draftForMockMint(mint: string) {
  return {
    version: 1 as const,
    deliveryId: 'EBESExQVFhcYGRobHB0eHw' as ProtocolId,
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
