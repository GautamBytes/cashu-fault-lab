import type { DeliveryPayload } from '@cashu-fault-lab/delivery-core';

export interface InspectProofs {
  readonly payload: DeliveryPayload;
}

export interface InspectProofsResult {
  readonly ys: readonly string[];
  readonly proofClaimIds: readonly string[];
  readonly proofSetHash: string;
  readonly netAmount: number;
}

export interface ProofVerifier {
  inspect(input: InspectProofs): Promise<InspectProofsResult>;
}
