import type { DeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import type { AcceptDeliveryDependencies } from './accept-delivery.js';
import { ReceiverDomainError } from './types.js';
import { isMintGatewayError } from '../ports/mint-gateway.js';

export async function recoverDelivery(
  deliveryId: string,
  deps: AcceptDeliveryDependencies,
): Promise<DeliveryReceipt> {
  const record = await deps.store.current(deliveryId);
  if (!record) throw new ReceiverDomainError('INVALID_STATE', 'Delivery does not exist');
  if (record.phase === 'settled' || record.phase === 'rejected') return record.receipt;

  try {
    const restored = await deps.mint.restore(record.plan);
    if (restored.kind === 'recovered') {
      return deps.store.settle({
        deliveryId,
        replacementPlanHash: restored.result.replacementPlanHash,
        replacementProofs: restored.result.replacementProofs,
        now: deps.now(),
      });
    }

    const states = await deps.mint.proofStates(record.plan);
    if (states.length !== record.plan.proofYs.length) {
      throw new ReceiverDomainError(
        'INVALID_STATE',
        'Mint returned incomplete proof state evidence',
      );
    }
    if (states.every((state) => state === 'UNSPENT')) {
      await deps.store.markMintSent(deliveryId);
      const swapped = await deps.mint.swap(record.plan);
      return deps.store.settle({
        deliveryId,
        replacementPlanHash: swapped.replacementPlanHash,
        replacementProofs: swapped.replacementProofs,
        now: deps.now(),
      });
    }
    return deps.store.blockRecovery(deliveryId);
  } catch (error) {
    if (isMintGatewayError(error) && !error.mayHaveConsumedInputs) {
      return deps.store.reject(deliveryId, 'mint_unavailable', true);
    }
    if (error instanceof ReceiverDomainError) throw error;
    return deps.store.blockRecovery(deliveryId);
  }
}
