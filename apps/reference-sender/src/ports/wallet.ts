import type { CashuProof, ProtocolId } from '@cashu-fault-lab/delivery-core';

export interface ReservePayment {
  readonly deliveryId: ProtocolId;
  readonly amount: number;
  readonly unit: string;
  readonly mints: readonly string[];
}

export interface ReservedProofSet {
  readonly mint: string;
  readonly unit: string;
  readonly netAmount: number;
  readonly proofs: readonly CashuProof[];
}

export interface SenderWallet {
  reserveExact(input: ReservePayment): Promise<ReservedProofSet>;
  markSettled(deliveryId: string): Promise<void>;
  releaseRejected(deliveryId: string): Promise<void>;
  markRecoveryRequired(deliveryId: string): Promise<void>;
}
