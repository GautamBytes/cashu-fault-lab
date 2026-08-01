import type {
  LifecycleOperationKind,
  LifecyclePhase,
} from '@cashu-fault-lab/wallet-lifecycle-core';

export type LifecycleDurability = 'process' | 'persistent' | 'restart_safe';
export type LifecycleRecoveryMechanism =
  'quote_state' | 'proof_state' | 'nut09_restore' | 'nut13_seed' | 'nut19_replay';

export interface LifecycleImplementationIdentity {
  readonly id: string;
  readonly version: string;
  readonly language: string;
  readonly runtime: string;
  readonly sourceDigest: string;
  readonly buildDigest: string;
}

export interface LifecycleMintIdentity {
  readonly id: string;
  readonly implementation: string;
  readonly version?: string;
}

export interface LifecycleCapabilities {
  readonly schemaVersion: 1;
  readonly implementation: LifecycleImplementationIdentity;
  readonly operations: readonly LifecycleOperationKind[];
  readonly nuts: readonly number[];
  readonly durability: LifecycleDurability;
  readonly recovery: readonly LifecycleRecoveryMechanism[];
  readonly mints: readonly LifecycleMintIdentity[];
}

interface LifecycleOperationCommon {
  readonly operationId: string;
  readonly mint: string;
  readonly unit: string;
}

export type LifecycleOperationInput =
  | (LifecycleOperationCommon & {
      readonly kind: 'mint';
      readonly amount: number;
      readonly method: 'bolt11';
    })
  | (LifecycleOperationCommon & {
      readonly kind: 'swap';
      readonly amount: number;
    })
  | (LifecycleOperationCommon & {
      readonly kind: 'send';
      readonly amount: number;
      readonly recipient: string;
    })
  | (LifecycleOperationCommon & {
      readonly kind: 'receive';
      readonly token: string;
    })
  | (LifecycleOperationCommon & {
      readonly kind: 'melt';
      readonly invoice: string;
      readonly preferAsync?: boolean;
    })
  | (LifecycleOperationCommon & {
      readonly kind: 'restore';
    })
  | (LifecycleOperationCommon & {
      readonly kind: 'reconcile';
      readonly targetOperationId: string;
    });

export interface LifecycleOperationView extends LifecycleOperationCommon {
  readonly kind: LifecycleOperationKind;
  readonly intentHash: string;
  readonly phase: LifecyclePhase;
  readonly evidenceCode?: string;
  readonly amount?: number;
  readonly inputFee?: number;
  readonly feeReserve?: number;
  readonly actualFee?: number;
  readonly change?: number;
  readonly requestHash?: string;
  readonly quoteHash?: string;
  readonly outputPlanHash?: string;
}

export interface LifecycleProofView {
  readonly proofId: string;
  readonly state: 'UNSPENT' | 'PENDING' | 'SPENT';
}

export interface LifecycleWalletView {
  readonly walletId: string;
  readonly mint: string;
  readonly unit: string;
  readonly balances: {
    readonly available: number;
    readonly reserved: number;
    readonly recoverable: number;
  };
  readonly proofs: readonly LifecycleProofView[];
}

export interface LifecycleEvidenceView {
  readonly sequence: number;
  readonly operationId: string;
  readonly source: 'adapter' | 'durable_state' | 'mint' | 'lightning';
  readonly event: string;
  readonly dataHash: string;
}

export interface LifecycleAdapterClient {
  capabilities(): Promise<LifecycleCapabilities>;
  reset(seed: string): Promise<void>;
  start(input: LifecycleOperationInput): Promise<LifecycleOperationView>;
  resume(operationId: string): Promise<LifecycleOperationView>;
  operation(operationId: string): Promise<LifecycleOperationView>;
  wallet(): Promise<LifecycleWalletView>;
  evidence(): Promise<readonly LifecycleEvidenceView[]>;
}

export type LifecycleRequestOperation = 'reset' | 'start' | 'resume';
export type LifecycleResponseOperation =
  'capabilities' | 'reset' | 'start' | 'resume' | 'operation' | 'wallet' | 'evidence';

export type LifecycleSchemaErrorCode =
  | 'UNKNOWN_OPERATION'
  | 'SCHEMA_ADDITIONAL_PROPERTY'
  | 'SCHEMA_CONST'
  | 'SCHEMA_ENUM'
  | 'SCHEMA_FORMAT'
  | 'SCHEMA_MAXIMUM'
  | 'SCHEMA_MAX_ITEMS'
  | 'SCHEMA_MINIMUM'
  | 'SCHEMA_MIN_ITEMS'
  | 'SCHEMA_MIN_LENGTH'
  | 'SCHEMA_ONE_OF'
  | 'SCHEMA_PATTERN'
  | 'SCHEMA_REQUIRED'
  | 'SCHEMA_TYPE'
  | 'SCHEMA_UNIQUE_ITEMS'
  | 'SCHEMA_VALIDATION';

export type LifecycleValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly errorCode: LifecycleSchemaErrorCode;
      readonly path: string;
      readonly message: string;
    };
