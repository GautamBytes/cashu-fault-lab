export type OracleTransport = 'http' | 'nostr';
export type MintProofState = 'UNSPENT' | 'PENDING' | 'SPENT';
export type OracleReceiptStatus = 'processing' | 'settled' | 'rejected';

export interface OracleRequest {
  readonly requestId: string;
  readonly singleUse: boolean;
}

export interface OracleDelivery {
  readonly requestId: string;
  readonly deliveryId: string;
  readonly payloadHash: string;
  readonly proofSetHash: string;
  readonly transports: ReadonlySet<OracleTransport>;
  readonly replacementPlanHash?: string;
}

export interface OracleCredit {
  readonly creditId: string;
  readonly requestId: string;
  readonly deliveryId: string;
  readonly amount: number;
  readonly unit: string;
}

export interface OracleReceipt {
  readonly requestId: string;
  readonly deliveryId: string;
  readonly payloadHash: string;
  readonly status: OracleReceiptStatus;
  readonly detailCode: string;
  readonly version: number;
  readonly amount: number;
  readonly unit: string;
}

export type Observation =
  | { readonly type: 'request_observed'; readonly requestId: string; readonly singleUse: boolean }
  | {
      readonly type: 'delivery_attempted';
      readonly requestId: string;
      readonly deliveryId: string;
      readonly payloadHash: string;
      readonly proofSetHash: string;
      readonly transport: OracleTransport;
    }
  | {
      readonly type: 'mint_proofs_state';
      readonly proofSetHash: string;
      readonly state: MintProofState;
    }
  | {
      readonly type: 'redemption_started';
      readonly deliveryId: string;
      readonly proofSetHash: string;
    }
  | {
      readonly type: 'receiver_settled';
      readonly deliveryId: string;
      readonly replacementPlanHash: string;
    }
  | ({ readonly type: 'merchant_credited' } & OracleCredit)
  | ({ readonly type: 'receipt_observed' } & OracleReceipt);

export interface OracleModel {
  readonly requests: ReadonlyMap<string, OracleRequest>;
  readonly deliveries: ReadonlyMap<string, OracleDelivery>;
  readonly proofOwners: ReadonlyMap<string, string>;
  readonly proofStates: ReadonlyMap<string, MintProofState>;
  readonly credits: ReadonlyMap<string, OracleCredit>;
  readonly receipts: ReadonlyMap<string, OracleReceipt>;
  readonly observations: readonly Observation[];
}

export function emptyOracleModel(): OracleModel {
  return {
    requests: new Map(),
    deliveries: new Map(),
    proofOwners: new Map(),
    proofStates: new Map(),
    credits: new Map(),
    receipts: new Map(),
    observations: [],
  };
}
