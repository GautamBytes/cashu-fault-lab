import type {
  LifecycleRecoveryMechanism,
  LifecycleEvidenceView,
  LifecycleOperationInput,
  LifecycleOperationView,
  LifecycleWalletView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';

export interface CashuTsLifecyclePreparedRequest {
  /** Exact, secret-bearing request state. Stores MUST encrypt this field at rest. */
  readonly requestMaterial: unknown;
  readonly method?: 'POST';
  readonly path?: string;
  readonly bodyHash?: string;
  readonly requestDigests?: readonly {
    readonly method: 'POST';
    readonly path: string;
    readonly bodyHash: string;
  }[];
  readonly requestHash?: string;
  readonly quoteHash?: string;
  readonly outputPlanHash?: string;
  readonly amount?: number;
  readonly inputFee?: number;
  readonly feeReserve?: number;
  readonly quoteObservations?: readonly CashuTsLifecycleQuoteObservation[];
  readonly proofChanges?: Omit<CashuTsLifecycleProofChanges, 'operationId'>;
}

interface CashuTsLifecycleCommitChanges {
  readonly proofChanges?: Omit<CashuTsLifecycleProofChanges, 'operationId'>;
  readonly evidence?: readonly CashuTsLifecycleEvidenceInput[];
  readonly recoveryMechanism?: LifecycleRecoveryMechanism;
  readonly quoteObservations?: readonly CashuTsLifecycleQuoteObservation[];
  /** Secret-bearing response state. Stores MUST encrypt this field at rest. */
  readonly resultMaterial?: unknown;
}

export type CashuTsLifecycleResult =
  | ({ readonly status: 'succeeded' } & CashuTsLifecycleAmounts & CashuTsLifecycleCommitChanges)
  | ({ readonly status: 'ambiguous' } & CashuTsLifecycleCommitChanges)
  | ({
      readonly status: 'failed_definitive';
      readonly evidenceCode: string;
    } & CashuTsLifecycleAmounts &
      CashuTsLifecycleCommitChanges)
  | ({
      readonly status: 'recovery_blocked';
      readonly evidenceCode: string;
    } & CashuTsLifecycleAmounts &
      CashuTsLifecycleCommitChanges);

export interface CashuTsLifecycleAmounts {
  readonly amount?: number;
  readonly inputFee?: number;
  readonly feeReserve?: number;
  readonly actualFee?: number;
  readonly change?: number;
  readonly quoteHash?: string;
}

export interface CashuTsLifecycleWalletPort {
  discoverSupportedNuts?(): Promise<readonly number[]>;
  readonly supportsSendHandoff?: boolean;
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
  readonly attemptCount: number;
  readonly recoveryMechanism?: LifecycleRecoveryMechanism;
  readonly quoteObservations?: readonly CashuTsLifecycleQuoteObservation[];
  readonly prepared?: CashuTsLifecyclePreparedRequest;
  /** Secret-bearing response state. Stores MUST encrypt this field at rest. */
  readonly resultMaterial?: unknown;
}

export interface CashuTsLifecycleQuoteObservation {
  readonly kind: 'mint' | 'melt';
  readonly state: 'UNPAID' | 'PAID' | 'ISSUED' | 'PENDING';
  readonly dataHash: string;
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
  /** Internal owner of an in-flight reservation; never exposed through lifecycle views. */
  readonly reservedByOperationId?: string;
  /** Exact, secret-bearing proof material. Stores MUST encrypt this field at rest. */
  readonly material: unknown;
}

export interface CashuTsLifecycleProofUpdate {
  readonly proofId: string;
  readonly state: CashuTsLifecycleStoredProof['state'];
  readonly bucket: CashuTsLifecycleProofBucket;
  /** Used by reconciliation to transition a reservation owned by its target operation. */
  readonly reservationOperationId?: string;
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
  readonly sendHandoffDurability: 'process-local' | 'persistent';
  reset(seed: string): Promise<void>;
  loadSeed(): Promise<string | undefined>;
  reserveCounterRange(
    keysetId: string,
    reservationId: string,
    count: number,
  ): Promise<{ readonly start: number; readonly count: number }>;
  counterHighWatermark(keysetId: string): Promise<number>;
  counterHighWatermarks(): Promise<
    readonly { readonly keysetId: string; readonly nextCounter: number }[]
  >;
  putSendHandoff(operationId: string, recipient: string, token: string): Promise<string>;
  /** Trusted internal outbox boundary. Tokens must never be returned by lifecycle HTTP routes. */
  claimSendHandoff(consumerId: string): Promise<
    | {
        readonly operationId: string;
        readonly recipient: string;
        readonly token: string;
        readonly tokenHash: string;
      }
    | undefined
  >;
  ackSendHandoff(operationId: string, tokenHash: string, consumerId: string): Promise<void>;
  loadSendHandoff(
    operationId: string,
  ): Promise<
    { readonly recipient: string; readonly token: string; readonly tokenHash: string } | undefined
  >;
  create(operation: CashuTsStoredLifecycleOperation): Promise<CashuTsLifecycleCreateResult>;
  get(operationId: string): Promise<CashuTsStoredLifecycleOperation | undefined>;
  put(operation: CashuTsStoredLifecycleOperation): Promise<void>;
  commit(
    operation: CashuTsStoredLifecycleOperation,
    proofChanges?: Omit<CashuTsLifecycleProofChanges, 'operationId'>,
    evidence?: readonly CashuTsLifecycleEvidenceInput[],
  ): Promise<void>;
  claim<T>(operationId: string, work: () => Promise<T>): Promise<T>;
  listProofs(mint: string, unit: string): Promise<readonly CashuTsLifecycleStoredProof[]>;
  applyProofChanges(changes: CashuTsLifecycleProofChanges): Promise<void>;
  walletView(walletId: string, mint: string, unit: string): Promise<LifecycleWalletView>;
  appendEvidence(evidence: CashuTsLifecycleEvidenceInput): Promise<void>;
  evidence(): Promise<readonly LifecycleEvidenceView[]>;
}
