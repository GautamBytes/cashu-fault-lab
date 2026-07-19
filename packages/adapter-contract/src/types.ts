import type { DeliveryReceiptWire } from '@cashu-fault-lab/delivery-core';

export type EvidenceTier = 'T0' | 'T1' | 'T2' | 'T3';
export type AdapterTransport = 'http' | 'nostr';
export type AdapterEncoding = 'creqA' | 'creqB';
export type AdapterRole = 'sender' | 'receiver';

export interface AdapterProfileCapability {
  readonly name: string;
  readonly roles: readonly AdapterRole[];
  readonly status: 'supported' | 'unsupported';
  readonly reason?: string;
}

export interface AdapterCapabilities {
  readonly implementation: string;
  readonly version: string;
  readonly nuts: readonly number[];
  readonly transports: readonly AdapterTransport[];
  readonly evidenceTier: EvidenceTier;
  readonly encodings?: readonly AdapterEncoding[];
  readonly profiles?: readonly AdapterProfileCapability[];
}

export interface ResetInput {
  readonly seed: string;
}

export interface CreateRequestInput {
  readonly amount: number;
  readonly unit: string;
  readonly description?: string;
  readonly transports: readonly AdapterTransport[];
  readonly singleUse: boolean;
  readonly expiresIn: number;
}

export interface TransportEndpointView {
  readonly type: 'post' | 'nostr';
  readonly target: string;
  readonly tags?: readonly (readonly string[])[];
}

export interface PaymentRequestView {
  readonly id: string;
  readonly raw: string;
  readonly amount: number;
  readonly unit: string;
  readonly singleUse: boolean;
  readonly expiresAt: number;
  readonly transports: readonly TransportEndpointView[];
}

export interface SendPaymentInput {
  readonly request: string;
  readonly deliveryId?: string;
  readonly memo?: string | null;
}

export type DeliveryReceiptView = DeliveryReceiptWire;

export interface LedgerCreditView {
  readonly requestId: string;
  readonly deliveryId: string;
  readonly amount: number;
  readonly unit: string;
  readonly creditCount: number;
  readonly createdAt: number;
}

export interface ProofEvidenceView {
  readonly deliveryId: string;
  readonly proofSetHash: string;
  readonly inputYs: readonly string[];
  readonly state: 'unspent' | 'pending' | 'spent' | 'unknown';
}

export interface AdapterClient {
  capabilities(): Promise<AdapterCapabilities>;
  reset(seed: string): Promise<void>;
  createRequest(input: CreateRequestInput): Promise<PaymentRequestView>;
  send(input: SendPaymentInput): Promise<DeliveryReceiptView>;
  delivery(deliveryId: string): Promise<DeliveryReceiptView>;
  ledger(): Promise<readonly LedgerCreditView[]>;
  proofs(): Promise<readonly ProofEvidenceView[]>;
}

export type AdapterRequestOperation = 'reset' | 'createRequest' | 'send';
export type AdapterResponseOperation =
  'capabilities' | 'reset' | 'createRequest' | 'send' | 'delivery' | 'ledger' | 'proofs';

export type SchemaErrorCode =
  | 'UNKNOWN_OPERATION'
  | 'SCHEMA_ADDITIONAL_PROPERTY'
  | 'SCHEMA_CONST'
  | 'SCHEMA_CONTAINS'
  | 'SCHEMA_ENUM'
  | 'SCHEMA_FORMAT'
  | 'SCHEMA_IF'
  | 'SCHEMA_MAXIMUM'
  | 'SCHEMA_MAX_ITEMS'
  | 'SCHEMA_MINIMUM'
  | 'SCHEMA_MIN_ITEMS'
  | 'SCHEMA_MIN_LENGTH'
  | 'SCHEMA_PATTERN'
  | 'SCHEMA_REQUIRED'
  | 'SCHEMA_TYPE'
  | 'SCHEMA_UNIQUE_ITEMS'
  | 'SCHEMA_VALIDATION';

export type ValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly errorCode: SchemaErrorCode;
      readonly path: string;
      readonly message: string;
    };
