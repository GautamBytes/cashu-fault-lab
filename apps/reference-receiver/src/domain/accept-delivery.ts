import type { DeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import type { AcceptDeliveryCommand, SwapPlanDraft } from './types.js';
import { ReceiverDomainError } from './types.js';
import { isMintGatewayError, type MintGateway } from '../ports/mint-gateway.js';
import type { ProofVerifier } from '../ports/proof-verifier.js';
import type { ReceiverStore } from '../ports/receiver-store.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface AcceptDeliveryDependencies {
  readonly store: ReceiverStore;
  readonly mint: MintGateway;
  readonly verifier: ProofVerifier;
  readonly now: () => number;
}

function createPlanDraft(
  command: AcceptDeliveryCommand,
  proofYs: readonly string[],
  netAmount: number,
): SwapPlanDraft {
  return {
    version: 1,
    deliveryId: command.payload.delivery.id,
    mint: command.payload.mint,
    unit: command.payload.unit,
    expectedAmount: netAmount,
    inputProofs: command.payload.proofs,
    proofYs,
  };
}

export async function acceptDelivery(
  command: AcceptDeliveryCommand,
  deps: AcceptDeliveryDependencies,
): Promise<DeliveryReceipt> {
  if (!HASH_PATTERN.test(command.payloadHash)) {
    throw new ReceiverDomainError('REQUEST_MISMATCH', 'Payload hash must be lowercase SHA-256');
  }
  const inspected = await deps.verifier.inspect({ payload: command.payload });
  const plan = await deps.mint.prepareSwap(
    createPlanDraft(command, inspected.ys, inspected.netAmount),
  );
  const prepared = await deps.store.prepare({
    command,
    proofSetHash: inspected.proofSetHash,
    proofClaimIds: inspected.proofClaimIds,
    proofYs: inspected.ys,
    netAmount: inspected.netAmount,
    plan,
    now: deps.now(),
  });
  if (prepared.kind === 'duplicate') return prepared.record.receipt;

  await deps.store.markMintSent(command.payload.delivery.id);
  try {
    const swapped = await deps.mint.swap(plan);
    return await deps.store.settle({
      deliveryId: command.payload.delivery.id,
      replacementPlanHash: swapped.replacementPlanHash,
      replacementProofs: swapped.replacementProofs,
      now: deps.now(),
    });
  } catch (error) {
    if (isMintGatewayError(error) && !error.mayHaveConsumedInputs) {
      return deps.store.reject(command.payload.delivery.id, 'mint_unavailable', true);
    }
    return deps.store.blockRecovery(command.payload.delivery.id);
  }
}
