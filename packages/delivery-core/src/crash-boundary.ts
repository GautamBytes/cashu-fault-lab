export const senderCrashBoundaries = [
  'sender_before_proof_reservation',
  'sender_after_reservation_before_payload_persistence',
  'sender_after_payload_persistence_before_network_send',
  'sender_after_send_before_response',
] as const;

export const receiverCrashBoundaries = [
  'receiver_before_mint_request',
  'receiver_after_mint_request_before_response',
  'receiver_after_mint_response_before_output_persistence',
  'receiver_after_output_persistence_before_merchant_credit',
  'receiver_after_credit_before_receipt_persistence',
  'receiver_after_receipt_persistence_before_response_or_outbox',
] as const;

export type SenderCrashBoundary = (typeof senderCrashBoundaries)[number];
export type ReceiverCrashBoundary = (typeof receiverCrashBoundaries)[number];
export type CrashBoundary = SenderCrashBoundary | ReceiverCrashBoundary;

export interface CrashCheckpoint {
  hit(boundary: CrashBoundary, deliveryId: string): Promise<void>;
}

export class CrashBoundaryHit extends Error {
  constructor(
    readonly boundary: CrashBoundary,
    readonly deliveryId: string,
  ) {
    super(`Crash boundary ${boundary} was hit`);
    this.name = 'CrashBoundaryHit';
  }
}

export const noopCrashCheckpoint: CrashCheckpoint = {
  async hit(): Promise<void> {},
};

export interface OneShotCrashCheckpointOptions {
  readonly boundary: CrashBoundary;
  readonly occurrence?: number;
}

export function createOneShotCrashCheckpoint(
  options: OneShotCrashCheckpointOptions,
): CrashCheckpoint {
  const occurrence = options.occurrence ?? 1;
  if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
    throw new Error('Crash checkpoint occurrence must be a positive safe integer');
  }
  let hits = 0;
  let fired = false;
  return {
    async hit(boundary, deliveryId): Promise<void> {
      if (boundary !== options.boundary || fired) return;
      hits += 1;
      if (hits !== occurrence) return;
      fired = true;
      throw new CrashBoundaryHit(boundary, deliveryId);
    },
  };
}
