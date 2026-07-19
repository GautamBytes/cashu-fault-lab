import { createHash } from 'node:crypto';
import { encode, rfc8949EncodeOptions } from 'cborg';
import { DeliveryValidationError } from './errors';
import type { ProtocolId } from './ids';
import { normalizeMintUrl } from './mint-url';

export interface CashuProof {
  readonly amount: number | bigint;
  readonly id: string;
  readonly secret: string;
  readonly C: string;
  readonly witness?: string;
  readonly dleq?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface PayloadFingerprintInput {
  readonly requestId: ProtocolId;
  readonly memo: string | null;
  readonly mint: string;
  readonly unit: string;
  readonly proofs: readonly CashuProof[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ProofSetFingerprintInput {
  readonly mint: string;
  readonly unit: string;
  readonly ys: readonly Uint8Array[];
}

function sha256Hex(value: unknown): string {
  const encoded = encode(value, rfc8949EncodeOptions);
  return createHash('sha256').update(encoded).digest('hex');
}

export function computePayloadHash(input: PayloadFingerprintInput): string {
  return sha256Hex([
    'cashu-delivery-v1/payload',
    input.requestId,
    input.memo,
    normalizeMintUrl(input.mint),
    input.unit,
    input.proofs,
    1,
    input.createdAt,
    input.expiresAt,
  ]);
}

export function computeProofSetHash(input: ProofSetFingerprintInput): string {
  const ys = input.ys.map((value) => {
    if (value.length !== 33 || (value[0] !== 2 && value[0] !== 3)) {
      throw new DeliveryValidationError(
        'INVALID_PROOF_POINT',
        'Proof Y must be a compressed 33-byte point with prefix 02 or 03',
      );
    }
    return Uint8Array.from(value);
  });
  ys.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  return sha256Hex(['cashu-delivery-v1/proof-set', normalizeMintUrl(input.mint), input.unit, ys]);
}
