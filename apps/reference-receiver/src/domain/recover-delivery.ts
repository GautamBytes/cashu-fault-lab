import type { DeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import type { AcceptDeliveryDependencies } from './accept-delivery.js';
import { ReceiverDomainError } from './types.js';
import { isMintGatewayError } from '../ports/mint-gateway.js';

export async function recoverDelivery(
  deliveryId: string,
  deps: AcceptDeliveryDependencies,
): Promise<DeliveryReceipt> {
  const recovery = await deps.store.withRedemptionLock(deliveryId, (lockedStore) =>
    recoverLockedDelivery(deliveryId, { ...deps, store: lockedStore }),
  );
  if (recovery.acquired) return recovery.value;
  const record = await deps.store.current(deliveryId);
  if (!record) throw new ReceiverDomainError('INVALID_STATE', 'Delivery does not exist');
  return record.receipt;
}

async function recoverLockedDelivery(
  deliveryId: string,
  deps: AcceptDeliveryDependencies,
): Promise<DeliveryReceipt> {
  const record = await deps.store.current(deliveryId);
  if (!record) throw new ReceiverDomainError('INVALID_STATE', 'Delivery does not exist');
  if (record.phase === 'settled' || record.phase === 'rejected') return record.receipt;

  try {
    if (record.phase === 'prepared') {
      await deps.store.markMintSent(deliveryId);
      return await swapAndSettle(deliveryId, record.plan, deps);
    }

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
    // NUT-07 is a snapshot. Even all-UNSPENT evidence cannot prove that an earlier
    // ambiguous swap is no longer executing at the mint, so never redispatch here.
    return deps.store.blockRecovery(deliveryId);
  } catch (error) {
    if (error instanceof ReceiverDomainError) throw error;
    return deps.store.blockRecovery(deliveryId);
  }
}

async function swapAndSettle(
  deliveryId: string,
  plan: Parameters<AcceptDeliveryDependencies['mint']['swap']>[0],
  deps: AcceptDeliveryDependencies,
): Promise<DeliveryReceipt> {
  try {
    const swapped = await deps.mint.swap(plan);
    return deps.store.settle({
      deliveryId,
      replacementPlanHash: swapped.replacementPlanHash,
      replacementProofs: swapped.replacementProofs,
      now: deps.now(),
    });
  } catch (error) {
    if (isMintGatewayError(error) && !error.mayHaveConsumedInputs) {
      return deps.store.reject(deliveryId, 'mint_unavailable', true);
    }
    throw error;
  }
}
