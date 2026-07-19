import type { DeliveryPayload, DeliveryReceipt, ProtocolId } from '@cashu-fault-lab/delivery-core';
import { createHash } from 'node:crypto';
import type {
  ExactSwapPlan,
  InspectProofs,
  InspectProofsResult,
  MintGateway,
  MintProofState,
  ProofVerifier,
  RestoreResult,
  SwapResult,
} from '../src/index.js';

export class FakeProofVerifier implements ProofVerifier {
  async inspect(input: InspectProofs): Promise<InspectProofsResult> {
    const proofKeys = input.payload.proofs.map((proof) =>
      createHash('sha256').update(`claim:${proof.secret}`).digest('hex'),
    );
    return {
      ys: input.payload.proofs.map((proof) => `Y:${proof.secret}`),
      proofClaimIds: proofKeys,
      proofSetHash: createHash('sha256').update(proofKeys.slice().sort().join('|')).digest('hex'),
      netAmount: input.payload.proofs.reduce((sum, proof) => sum + proof.amount, 0),
    };
  }
}

export type FakeMintMode = 'success' | 'timeout_before_commit' | 'timeout_after_commit';

export class FakeMint implements MintGateway {
  mode: FakeMintMode = 'success';
  swapCalls = 0;
  readonly committed = new Map<string, SwapResult>();

  async swap(plan: ExactSwapPlan): Promise<SwapResult> {
    this.swapCalls += 1;
    if (this.mode === 'timeout_before_commit') {
      const { MintGatewayError } = await import('../src/index.js');
      throw new MintGatewayError('MINT_TIMEOUT', 'timeout before commit', false);
    }
    const result = {
      replacementPlanHash: `replacement:${plan.deliveryId}`,
      replacementProofs: [`proof:${plan.deliveryId}`],
    } satisfies SwapResult;
    this.committed.set(plan.deliveryId, result);
    if (this.mode === 'timeout_after_commit') {
      const { MintGatewayError } = await import('../src/index.js');
      throw new MintGatewayError('MINT_TIMEOUT', 'timeout after commit', true);
    }
    return result;
  }

  async restore(plan: ExactSwapPlan): Promise<RestoreResult> {
    const result = this.committed.get(plan.deliveryId);
    return result ? { kind: 'recovered', result } : { kind: 'not_found' };
  }

  async proofStates(plan: ExactSwapPlan): Promise<readonly MintProofState[]> {
    const state = this.committed.has(plan.deliveryId) ? 'SPENT' : 'UNSPENT';
    return plan.proofYs.map(() => state);
  }
}

export function payload(
  requestId: string,
  deliveryId: string,
  now: number,
  overrides: Readonly<Record<string, unknown>> = {},
): DeliveryPayload {
  const base: DeliveryPayload = {
    id: requestId as ProtocolId,
    memo: null,
    mint: 'https://mint.example',
    unit: 'sat',
    proofs: [{ amount: 8, id: '00aa', secret: 'secret-a', C: '02aa' }],
    delivery: {
      version: 1,
      id: deliveryId as ProtocolId,
      createdAt: now,
      expiresAt: now + 900,
    },
  };
  return { ...base, ...overrides } as DeliveryPayload;
}

export function expectSettled(receipt: DeliveryReceipt): void {
  if (receipt.status !== 'settled') throw new Error(`Expected settled, got ${receipt.status}`);
}
