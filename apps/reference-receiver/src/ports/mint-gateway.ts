import type { ExactSwapPlan, SwapPlanDraft } from '../domain/types.js';

export type MintProofState = 'UNSPENT' | 'PENDING' | 'SPENT' | 'UNKNOWN';

export interface SwapResult {
  readonly replacementPlanHash: string;
  readonly replacementProofs: readonly string[];
}

export type RestoreResult =
  { readonly kind: 'recovered'; readonly result: SwapResult } | { readonly kind: 'not_found' };

export class MintGatewayError extends Error {
  readonly code: string;
  readonly mayHaveConsumedInputs: boolean;

  constructor(code: string, message: string, mayHaveConsumedInputs: boolean) {
    super(message);
    this.name = 'MintGatewayError';
    this.code = code;
    this.mayHaveConsumedInputs = mayHaveConsumedInputs;
  }
}

export interface MintGateway {
  prepareSwap(draft: SwapPlanDraft): Promise<ExactSwapPlan>;
  swap(plan: ExactSwapPlan): Promise<SwapResult>;
  restore(plan: ExactSwapPlan): Promise<RestoreResult>;
  proofStates(plan: ExactSwapPlan): Promise<readonly MintProofState[]>;
}

export function isMintGatewayError(value: unknown): value is MintGatewayError {
  return (
    value instanceof MintGatewayError ||
    (typeof value === 'object' &&
      value !== null &&
      typeof Reflect.get(value, 'mayHaveConsumedInputs') === 'boolean')
  );
}
