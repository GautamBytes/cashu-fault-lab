import type { DeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import type { AcceptDeliveryCommand, SwapPlanDraft } from './types.js';
import { ReceiverDomainError } from './types.js';
import { recoverDelivery } from './recover-delivery.js';
import type { MintGateway } from '../ports/mint-gateway.js';
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
  const now = deps.now();
  const previous = await deps.store.preflight(command, now);
  if (previous) return previous.receipt;
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
  return recoverDelivery(command.payload.delivery.id, deps);
}
