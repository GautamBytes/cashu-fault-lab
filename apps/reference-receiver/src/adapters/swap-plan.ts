import { createHash } from 'node:crypto';
import type { CashuProof } from '@cashu-fault-lab/delivery-core';
import type { ExactSwapPlan, SwapOutputPlan, SwapPlanDraft } from '../domain/types.js';

const HEX_32 = /^[0-9a-f]{64}$/;
const COMPRESSED_POINT = /^(02|03)[0-9a-fA-F]{64}$/;

export interface ExactSwapPlanMaterial {
  readonly keysetId: string;
  readonly inputFeePpk: number;
  readonly outputs: readonly SwapOutputPlan[];
  readonly preparedAt: number;
  readonly recovery: ExactSwapPlan['recovery'];
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
}

function networkProof(proof: CashuProof): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(proof).filter(([key]) => key !== 'dleq' && key !== 'p2pk_e'),
  );
}

function validateOutput(output: SwapOutputPlan, keysetId: string): void {
  assertSafeInteger(output.amount, 'Swap output amount');
  if (output.amount === 0) throw new Error('Swap output amount must be positive');
  if (output.id !== keysetId) throw new Error('Swap output keyset binding is invalid');
  if (!COMPRESSED_POINT.test(output.B_)) throw new Error('Swap output B_ is invalid');
  if (output.secret.length === 0) throw new Error('Swap output secret is missing');
  if (!HEX_32.test(output.blindingFactor)) {
    throw new Error('Swap output blinding factor must be lowercase 32-byte hex');
  }
}

export function createExactSwapPlan(
  draft: SwapPlanDraft,
  material: ExactSwapPlanMaterial,
): ExactSwapPlan {
  if (material.keysetId.length === 0) throw new Error('Swap output keyset is required');
  assertSafeInteger(material.inputFeePpk, 'Input fee PPK');
  assertSafeInteger(material.preparedAt, 'Swap preparation time');
  if (material.outputs.length === 0) throw new Error('Swap plan needs at least one output');
  for (const output of material.outputs) validateOutput(output, material.keysetId);
  const outputAmount = material.outputs.reduce((sum, output) => sum + output.amount, 0);
  if (!Number.isSafeInteger(outputAmount) || outputAmount !== draft.expectedAmount) {
    throw new Error('Swap output amount must equal the expected net amount');
  }
  const replayUntil = material.recovery.nut19ReplayUntil;
  if (
    replayUntil !== null &&
    (!Number.isSafeInteger(replayUntil) || replayUntil < material.preparedAt)
  ) {
    throw new Error('NUT-19 replay deadline is invalid');
  }
  const request = {
    inputs: draft.inputProofs.map(networkProof),
    outputs: material.outputs.map(({ amount, id, B_ }) => ({ amount, id, B_ })),
  };
  return {
    ...structuredClone(draft),
    keysetId: material.keysetId,
    inputFeePpk: material.inputFeePpk,
    outputs: structuredClone(material.outputs),
    serializedRequest: JSON.stringify(request),
    preparedAt: material.preparedAt,
    recovery: structuredClone(material.recovery),
  };
}

export function replacementPlanHash(plan: ExactSwapPlan): string {
  return createHash('sha256')
    .update('cashu-fault-lab/replacement-plan-v1\0')
    .update(plan.serializedRequest)
    .digest('hex');
}
