import type { CrashBoundary, DeliveryReceiptWire } from '@cashu-fault-lab/delivery-core';

export type EvidenceTier = 'T0' | 'T1' | 'T2' | 'T3';
export type AdapterTransport = 'http' | 'nostr';
export type AdapterEncoding = 'creqA' | 'creqB';
export type AdapterRole = 'sender' | 'receiver';
export type EvidenceSource =
  'adapter' | 'runner' | 'transport' | 'mint' | 'durable_ledger' | 'durable_state';
export type DurabilityLevel = 'process' | 'persistent' | 'restart_safe';

export interface AdapterImplementationIdentity {
  readonly id: string;
  readonly version: string;
  readonly language: string;
  readonly runtime: string;
  readonly sourceDigest: string;
  readonly buildDigest: string;
}

export interface AdapterRoleEvidence {
  readonly tier: EvidenceTier;
  readonly sources: readonly EvidenceSource[];
}

export interface AdapterRoleCapability {
  readonly transports: readonly AdapterTransport[];
  readonly profiles: readonly string[];
  readonly durability: DurabilityLevel;
  readonly evidence: AdapterRoleEvidence;
}

export interface AdapterMintIdentity {
  readonly id: string;
  readonly implementation: string;
  readonly version?: string;
}

export interface AdapterContractMetadata {
  readonly apiVersion: number;
  readonly schemaVersion: number;
  readonly specDigest: string;
}

export interface AdapterCapabilities {
  readonly schemaVersion: 2;
  readonly contract?: AdapterContractMetadata;
  readonly implementation: AdapterImplementationIdentity;
  readonly roles: {
    readonly sender?: AdapterRoleCapability;
    readonly receiver?: AdapterRoleCapability;
  };
  readonly nuts: readonly number[];
  readonly encodings: readonly AdapterEncoding[];
  readonly mints: readonly AdapterMintIdentity[];
  readonly testControls?: AdapterTestControls;
}

export interface AdapterTestControls {
  readonly crashBoundaries: readonly CrashBoundary[];
}

export interface CrashArmInput {
  readonly runId: string;
  readonly component: AdapterRole;
  readonly boundary: CrashBoundary;
  readonly occurrence: number;
}

export interface CrashArmStatus extends CrashArmInput {
  readonly hits: number;
  readonly consumed: boolean;
}

export interface AdapterTestControlClient {
  armCrash(input: CrashArmInput): Promise<void>;
  crashStatus(): Promise<readonly CrashArmStatus[]>;
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

export type AdapterRequestOperation = 'reset' | 'createRequest' | 'send' | 'armCrash';
export type AdapterResponseOperation =
  | 'capabilities'
  | 'reset'
  | 'createRequest'
  | 'send'
  | 'delivery'
  | 'ledger'
  | 'proofs'
  | 'armCrash'
  | 'crashStatus';

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

export interface AdapterCompatibilityWarning {
  readonly code: 'ADAPTER_CONTRACT_LEGACY';
  readonly message: string;
  readonly remediation: string;
}

export type AdapterCompatibilityResult =
  | {
      readonly ok: true;
      readonly metadata?: AdapterContractMetadata;
      readonly warnings: readonly AdapterCompatibilityWarning[];
    }
  | {
      readonly ok: false;
      readonly code: 'ADAPTER_CONTRACT_INCOMPATIBLE';
      readonly reason: string;
      readonly expected: AdapterContractMetadata;
      readonly actual: AdapterContractMetadata;
    };
