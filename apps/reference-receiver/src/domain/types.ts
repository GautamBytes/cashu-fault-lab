import type {
  CashuProof,
  DeliveryPayload,
  DeliveryReceipt,
  ProtocolId,
} from '@cashu-fault-lab/delivery-core';

export type ReceiverErrorCode =
  | 'INVALID_REQUEST'
  | 'REQUEST_NOT_FOUND'
  | 'REQUEST_EXPIRED'
  | 'DELIVERY_EXPIRED'
  | 'DELIVERY_TIME_INVALID'
  | 'REQUEST_MISMATCH'
  | 'MINT_MISMATCH'
  | 'UNIT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'DELIVERY_CONFLICT'
  | 'PROOF_CONFLICT'
  | 'SINGLE_USE_CONFLICT'
  | 'INVALID_PROOF_EVIDENCE'
  | 'INVALID_STATE';

export class ReceiverDomainError extends Error {
  readonly code: ReceiverErrorCode;

  constructor(code: ReceiverErrorCode, message: string) {
    super(message);
    this.name = 'ReceiverDomainError';
    this.code = code;
  }
}

export interface CreatePaymentRequest {
  readonly id: string;
  readonly amount: number;
  readonly unit: string;
  readonly mints: readonly string[];
  readonly singleUse: boolean;
  readonly expiresAt: number;
}

export interface PaymentRequestRecord {
  readonly id: ProtocolId;
  readonly amount: number;
  readonly unit: string;
  readonly mints: readonly string[];
  readonly singleUse: boolean;
  readonly expiresAt: number;
}

export interface AcceptDeliveryCommand {
  readonly payload: DeliveryPayload;
  readonly payloadHash: string;
}

export interface ExactSwapPlan {
  readonly version: 1;
  readonly deliveryId: ProtocolId;
  readonly mint: string;
  readonly unit: string;
  readonly expectedAmount: number;
  readonly inputProofs: readonly CashuProof[];
  readonly proofYs: readonly string[];
  readonly outputDerivation: {
    readonly strategy: 'delivery-id-v1';
    readonly counter: 0;
  };
}

export type DeliveryPhase = 'prepared' | 'mint_sent' | 'recovery_blocked' | 'settled' | 'rejected';

export interface DeliveryRecord {
  readonly requestId: ProtocolId;
  readonly deliveryId: ProtocolId;
  readonly payloadHash: string;
  readonly proofSetHash: string;
  readonly proofClaimIds: readonly string[];
  readonly plan: ExactSwapPlan;
  readonly amount: number;
  readonly phase: DeliveryPhase;
  readonly receipt: DeliveryReceipt;
  readonly replacementPlanHash?: string;
  readonly replacementProofs?: readonly string[];
}

export interface MerchantCredit {
  readonly creditId: string;
  readonly requestId: ProtocolId;
  readonly deliveryId: ProtocolId;
  readonly amount: number;
  readonly unit: string;
  readonly createdAt: number;
}

export interface PrepareDelivery {
  readonly command: AcceptDeliveryCommand;
  readonly proofSetHash: string;
  readonly proofClaimIds: readonly string[];
  readonly proofYs: readonly string[];
  readonly netAmount: number;
  readonly plan: ExactSwapPlan;
  readonly now: number;
}

export type PrepareResult =
  | { readonly kind: 'prepared'; readonly record: DeliveryRecord }
  | { readonly kind: 'duplicate'; readonly record: DeliveryRecord };

export interface CommitSettlement {
  readonly deliveryId: string;
  readonly replacementPlanHash: string;
  readonly replacementProofs: readonly string[];
  readonly now: number;
}
