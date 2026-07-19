import { DeliveryValidationError } from './errors.js';

export interface AmountProof {
  readonly amount: number;
  readonly id: string;
}

function invalidAmount(message: string): never {
  throw new DeliveryValidationError('INVALID_AMOUNT', message);
}

function assertNonnegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    invalidAmount(`${name} must be a nonnegative safe integer`);
}

export function computeInputFee(
  proofs: readonly AmountProof[],
  inputFeePpkByKeyset: ReadonlyMap<string, number>,
): number {
  let sumPpk = 0;
  for (const proof of proofs) {
    const feePpk = inputFeePpkByKeyset.get(proof.id);
    if (feePpk === undefined) {
      throw new DeliveryValidationError('UNKNOWN_KEYSET', `Unknown proof keyset: ${proof.id}`);
    }
    if (!Number.isSafeInteger(feePpk) || feePpk < 0)
      invalidAmount('Input fee must be a nonnegative safe integer');
    sumPpk += feePpk;
    if (!Number.isSafeInteger(sumPpk)) invalidAmount('Input fee sum must remain a safe integer');
  }
  const wholeUnits = Math.floor(sumPpk / 1_000);
  return wholeUnits + (sumPpk % 1_000 === 0 ? 0 : 1);
}

export function computeNetAmount(
  proofs: readonly AmountProof[],
  inputFeePpkByKeyset: ReadonlyMap<string, number>,
): number {
  let gross = 0;
  for (const proof of proofs) {
    assertNonnegativeSafeInteger(proof.amount, 'Proof amount');
    gross += proof.amount;
    if (!Number.isSafeInteger(gross)) invalidAmount('Proof amount sum must remain a safe integer');
  }
  const net = gross - computeInputFee(proofs, inputFeePpkByKeyset);
  if (!Number.isSafeInteger(net) || net < 0)
    invalidAmount('Net amount must be a nonnegative safe integer');
  return net;
}

export function assertExactRequestedAmount(actual: number, requested: number): void {
  assertNonnegativeSafeInteger(actual, 'Actual amount');
  assertNonnegativeSafeInteger(requested, 'Requested amount');
  if (actual !== requested) {
    throw new DeliveryValidationError(
      'AMOUNT_MISMATCH',
      'Payment must equal the exact requested net amount',
    );
  }
}
