import { CrashBoundaryHit, type DeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import { receiverCrashCheckpoint, type AcceptDeliveryDependencies } from './accept-delivery.js';
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
      await receiverCrashCheckpoint(deps).hit('receiver_before_mint_request', deliveryId);
      await deps.store.markMintSent(deliveryId);
      return await swapAndSettle(deliveryId, record.plan, deps);
    }
    if (record.phase === 'outputs_persisted') {
      if (record.replacementPlanHash === undefined || record.replacementProofs === undefined) {
        throw new ReceiverDomainError('INVALID_STATE', 'Persisted settlement outputs are missing');
      }
      return settleWithCheckpoints(
        {
          deliveryId,
          replacementPlanHash: record.replacementPlanHash,
          replacementProofs: record.replacementProofs,
          now: deps.now(),
        },
        deps,
      );
    }
    if (record.phase === 'credited') {
      await receiverCrashCheckpoint(deps).hit(
        'receiver_after_credit_before_receipt_persistence',
        deliveryId,
      );
      const receipt = await deps.store.finalizeSettlement(deliveryId);
      await receiverCrashCheckpoint(deps).hit(
        'receiver_after_receipt_persistence_before_response_or_outbox',
        deliveryId,
      );
      return receipt;
    }

    const restored = await deps.mint.restore(record.plan);
    if (restored.kind === 'recovered') {
      return settleWithCheckpoints(
        {
          deliveryId,
          replacementPlanHash: restored.result.replacementPlanHash,
          replacementProofs: restored.result.replacementProofs,
          now: deps.now(),
        },
        deps,
      );
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
    if (error instanceof ReceiverDomainError || error instanceof CrashBoundaryHit) throw error;
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
    await receiverCrashCheckpoint(deps).hit(
      'receiver_after_mint_request_before_response',
      deliveryId,
    );
    return settleWithCheckpoints(
      {
        deliveryId,
        replacementPlanHash: swapped.replacementPlanHash,
        replacementProofs: swapped.replacementProofs,
        now: deps.now(),
      },
      deps,
    );
  } catch (error) {
    if (isMintGatewayError(error) && !error.mayHaveConsumedInputs) {
      return deps.store.reject(deliveryId, 'mint_unavailable', true);
    }
    throw error;
  }
}

async function settleWithCheckpoints(
  input: Parameters<AcceptDeliveryDependencies['store']['settle']>[0],
  deps: AcceptDeliveryDependencies,
): Promise<DeliveryReceipt> {
  const checkpoint = receiverCrashCheckpoint(deps);
  await checkpoint.hit('receiver_after_mint_response_before_output_persistence', input.deliveryId);
  await deps.store.persistSettlementOutputs(input);
  await checkpoint.hit(
    'receiver_after_output_persistence_before_merchant_credit',
    input.deliveryId,
  );
  await deps.store.creditSettlement(input.deliveryId, input.now);
  await checkpoint.hit('receiver_after_credit_before_receipt_persistence', input.deliveryId);
  const receipt = await deps.store.finalizeSettlement(input.deliveryId);
  await checkpoint.hit(
    'receiver_after_receipt_persistence_before_response_or_outbox',
    input.deliveryId,
  );
  return receipt;
}
