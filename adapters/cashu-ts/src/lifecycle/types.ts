import type {
  LifecycleEvidenceView,
  LifecycleOperationInput,
  LifecycleOperationView,
  LifecycleWalletView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';

export interface CashuTsLifecyclePreparedRequest {
  /** Exact, secret-bearing request state. Stores MUST encrypt this field at rest. */
  readonly requestMaterial: unknown;
  readonly requestHash?: string;
  readonly quoteHash?: string;
  readonly outputPlanHash?: string;
  readonly amount?: number;
  readonly inputFee?: number;
  readonly feeReserve?: number;
}

export type CashuTsLifecycleResult =
  | ({ readonly status: 'succeeded' } & CashuTsLifecycleAmounts)
  | { readonly status: 'ambiguous' }
  | ({
      readonly status: 'failed_definitive';
      readonly evidenceCode: string;
    } & CashuTsLifecycleAmounts)
  | ({
      readonly status: 'recovery_blocked';
      readonly evidenceCode: string;
    } & CashuTsLifecycleAmounts);

export interface CashuTsLifecycleAmounts {
  readonly amount?: number;
  readonly inputFee?: number;
  readonly feeReserve?: number;
  readonly actualFee?: number;
  readonly change?: number;
  readonly quoteHash?: string;
}

export interface CashuTsLifecycleWalletPort {
  reset(seed: string): Promise<void>;
  prepare(input: LifecycleOperationInput): Promise<CashuTsLifecyclePreparedRequest>;
  submit(prepared: CashuTsLifecyclePreparedRequest): Promise<CashuTsLifecycleResult>;
  recover(
    input: LifecycleOperationInput,
    view: LifecycleOperationView,
    prepared?: CashuTsLifecyclePreparedRequest,
  ): Promise<CashuTsLifecycleResult>;
}

export interface CashuTsStoredLifecycleOperation {
  readonly input: LifecycleOperationInput;
  readonly view: LifecycleOperationView;
  readonly prepared?: CashuTsLifecyclePreparedRequest;
}

export interface CashuTsLifecycleCreateResult {
  readonly created: boolean;
  readonly operation: CashuTsStoredLifecycleOperation;
}

export type CashuTsLifecycleProofBucket = 'available' | 'reserved' | 'recoverable';

export interface CashuTsLifecycleStoredProof {
  readonly proofId: string;
  readonly mint: string;
  readonly unit: string;
  readonly amount: number;
  readonly state: 'UNSPENT' | 'PENDING' | 'SPENT';
  readonly bucket: CashuTsLifecycleProofBucket;
  /** Exact, secret-bearing proof material. Stores MUST encrypt this field at rest. */
  readonly material: unknown;
}

export interface CashuTsLifecycleProofUpdate {
  readonly proofId: string;
  readonly state: CashuTsLifecycleStoredProof['state'];
  readonly bucket: CashuTsLifecycleProofBucket;
}

export interface CashuTsLifecycleProofChanges {
  readonly operationId: string;
  readonly add: readonly CashuTsLifecycleStoredProof[];
  readonly update: readonly CashuTsLifecycleProofUpdate[];
}

export interface CashuTsLifecycleEvidenceInput extends Omit<LifecycleEvidenceView, 'sequence'> {
  readonly effectId: string;
}

export interface CashuTsLifecycleStore {
  reset(seed: string): Promise<void>;
  loadSeed(): Promise<string | undefined>;
  create(operation: CashuTsStoredLifecycleOperation): Promise<CashuTsLifecycleCreateResult>;
  get(operationId: string): Promise<CashuTsStoredLifecycleOperation | undefined>;
  put(operation: CashuTsStoredLifecycleOperation): Promise<void>;
  claim<T>(operationId: string, work: () => Promise<T>): Promise<T>;
  listProofs(mint: string, unit: string): Promise<readonly CashuTsLifecycleStoredProof[]>;
  applyProofChanges(changes: CashuTsLifecycleProofChanges): Promise<void>;
  walletView(walletId: string, mint: string, unit: string): Promise<LifecycleWalletView>;
  appendEvidence(evidence: CashuTsLifecycleEvidenceInput): Promise<void>;
  evidence(): Promise<readonly LifecycleEvidenceView[]>;
}
