import type {
  LifecycleOperationRecord,
  LifecyclePhase,
} from '@cashu-fault-lab/wallet-lifecycle-core';

export type LifecycleProofState = 'UNSPENT' | 'PENDING' | 'SPENT';
export type LifecycleRequestKind = 'mint' | 'swap' | 'melt';

export type LifecycleObservation =
  | {
      readonly type: 'operation_observed';
      readonly operation: LifecycleOperationRecord;
    }
  | {
      readonly type: 'phase_observed';
      readonly operationId: string;
      readonly phase: LifecyclePhase;
      readonly evidenceCode?: string;
    }
  | {
      readonly type: 'value_moved';
      readonly operationId: string;
      readonly effectId: string;
      readonly unit: string;
      readonly amount: number;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly type: 'request_dispatched';
      readonly operationId: string;
      readonly requestKind: LifecycleRequestKind;
      readonly method: 'POST';
      readonly path: string;
      readonly bodyHash: string;
    }
  | {
      readonly type: 'mint_quote_observed';
      readonly operationId: string;
      readonly quoteHash: string;
      readonly amountPaid: number;
      readonly amountIssued: number;
      readonly updatedAt: number;
    }
  | {
      readonly type: 'proof_state_observed';
      readonly operationId: string;
      readonly proofId: string;
      readonly owner: string;
      readonly state: LifecycleProofState;
    }
  | {
      readonly type: 'lightning_settlement_observed';
      readonly operationId: string;
      readonly invoiceHash: string;
      readonly paymentHash: string;
      readonly amount: number;
      readonly unit: string;
    }
  | {
      readonly type: 'outputs_persisted';
      readonly operationId: string;
      readonly outputPlanHash: string;
      readonly amount: number;
      readonly unit: string;
    };

export interface LifecycleModel {
  readonly observations: readonly LifecycleObservation[];
}

export interface LifecycleEvaluation {
  readonly operations: ReadonlyMap<string, LifecycleOperationRecord>;
  readonly balances: ReadonlyMap<string, number>;
  readonly effects: ReadonlyMap<
    string,
    Extract<LifecycleObservation, { readonly type: 'value_moved' }>
  >;
  readonly requests: ReadonlyMap<
    string,
    Extract<LifecycleObservation, { readonly type: 'request_dispatched' }>
  >;
  readonly quotes: ReadonlyMap<
    string,
    Extract<LifecycleObservation, { readonly type: 'mint_quote_observed' }>
  >;
  readonly proofs: ReadonlyMap<
    string,
    Extract<LifecycleObservation, { readonly type: 'proof_state_observed' }>
  >;
  readonly settlements: ReadonlyMap<
    string,
    Extract<LifecycleObservation, { readonly type: 'lightning_settlement_observed' }>
  >;
  readonly outputs: ReadonlyMap<
    string,
    Extract<LifecycleObservation, { readonly type: 'outputs_persisted' }>
  >;
}

export function emptyLifecycleModel(): LifecycleModel {
  return Object.freeze({ observations: Object.freeze([]) });
}
