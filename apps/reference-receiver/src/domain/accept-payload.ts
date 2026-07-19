import {
  computePayloadHash,
  parseDeliveryPayloadJson,
  type DeliveryReceipt,
} from '@cashu-fault-lab/delivery-core';
import { acceptDelivery, type AcceptDeliveryDependencies } from './accept-delivery.js';

export async function acceptPayloadBytes(
  payloadBytes: Uint8Array,
  dependencies: AcceptDeliveryDependencies,
): Promise<DeliveryReceipt> {
  const payload = parseDeliveryPayloadJson(payloadBytes, dependencies.now());
  const payloadHash = computePayloadHash({
    requestId: payload.id,
    memo: payload.memo,
    mint: payload.mint,
    unit: payload.unit,
    proofs: payload.proofs,
    createdAt: payload.delivery.createdAt,
    expiresAt: payload.delivery.expiresAt,
  });
  return acceptDelivery({ payload, payloadHash }, dependencies);
}
