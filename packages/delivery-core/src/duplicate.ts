export interface ExistingDeliveryBinding {
  readonly requestId: string;
  readonly deliveryId: string;
  readonly payloadHash: string;
  readonly proofSetHash: string;
  readonly holdsProofClaim: boolean;
  readonly holdsRequestReservation: boolean;
}

export type DeliveryClassification =
  'new' | 'duplicate' | 'delivery_conflict' | 'proof_conflict' | 'single_use_conflict';

export function classifyDelivery(
  existing: readonly ExistingDeliveryBinding[],
  incoming: ExistingDeliveryBinding,
  singleUse: boolean,
): DeliveryClassification {
  const sameDelivery = existing.find((item) => item.deliveryId === incoming.deliveryId);
  if (sameDelivery) {
    return sameDelivery.payloadHash === incoming.payloadHash &&
      sameDelivery.proofSetHash === incoming.proofSetHash &&
      sameDelivery.requestId === incoming.requestId
      ? 'duplicate'
      : 'delivery_conflict';
  }

  if (
    existing.some((item) => item.holdsProofClaim && item.proofSetHash === incoming.proofSetHash)
  ) {
    return 'proof_conflict';
  }

  if (
    singleUse &&
    existing.some((item) => item.holdsRequestReservation && item.requestId === incoming.requestId)
  ) {
    return 'single_use_conflict';
  }

  return 'new';
}
