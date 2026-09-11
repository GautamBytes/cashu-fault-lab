import type { PreparedRedemption } from './types.js';

export function verifyWalletPayloads(
  token: unknown,
  history: unknown,
  expected: { mint: string; amount: number; outputs: PreparedRedemption['outputs'] },
): boolean {
  if (!token || typeof token !== 'object' || Array.isArray(token) || !Array.isArray(history))
    return false;
  const payload = token as Record<string, unknown>;
  if (
    payload.mint !== expected.mint ||
    payload.unit !== 'sat' ||
    !Array.isArray(payload.del) ||
    payload.del.length !== 0 ||
    !Array.isArray(payload.proofs) ||
    payload.proofs.length !== expected.outputs.length ||
    !history.every((tag) => Array.isArray(tag) && tag.every((value) => typeof value === 'string'))
  )
    return false;
  const proofs = payload.proofs;
  if (proofs.some((proof) => !proof || typeof proof !== 'object' || Array.isArray(proof)))
    return false;
  if (
    new Set(proofs.map((proof) => proof.secret)).size !== proofs.length ||
    proofs.some(
      (proof) =>
        !expected.outputs.some(
          (output) =>
            proof.secret === output.secret &&
            proof.id === output.id &&
            proof.amount === output.amount,
        ),
    ) ||
    proofs.reduce((sum, proof) => sum + proof.amount, 0) !== expected.amount
  )
    return false;
  return [
    ['direction', 'in'],
    ['amount', String(expected.amount)],
    ['unit', 'sat'],
  ].every(([name, value]) => {
    const tags = history.filter((tag) => tag[0] === name);
    return tags.length === 1 && tags[0]?.length === 2 && tags[0]?.[1] === value;
  });
}
