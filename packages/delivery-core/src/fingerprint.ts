import { createHash, ECDH } from 'node:crypto';
import { encode, rfc8949EncodeOptions } from 'cborg';
import { DeliveryValidationError } from './errors';
import { parseProtocolId, type ProtocolId } from './ids';
import { normalizeMintUrl } from './mint-url';

export type JsonPrimitive = null | boolean | string | number;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CashuProof {
  readonly amount: number;
  readonly id: string;
  readonly secret: string;
  readonly C: string;
  readonly witness?: string;
  readonly dleq?: Readonly<Record<string, JsonValue>>;
  readonly [key: string]: JsonValue | undefined;
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

export type CompressedPoint = Uint8Array & { readonly CompressedPoint: unique symbol };

export function parseCompressedPoint(value: Uint8Array): CompressedPoint {
  if (
    !(value instanceof Uint8Array) ||
    value.length !== 33 ||
    (value[0] !== 2 && value[0] !== 3)
  ) {
    throw new DeliveryValidationError(
      'INVALID_PROOF_POINT',
      'Proof Y must be a compressed 33-byte point with prefix 02 or 03',
    );
  }

  try {
    const canonical = ECDH.convertKey(
      Buffer.from(value),
      'secp256k1',
      undefined,
      undefined,
      'compressed',
    );
    if (!canonical.equals(Buffer.from(value))) {
      throw new Error('non-canonical point');
    }
    return Uint8Array.from(canonical) as CompressedPoint;
  } catch {
    throw new DeliveryValidationError(
      'INVALID_PROOF_POINT',
      'Proof Y must encode a valid secp256k1 point',
    );
  }
}

function canonicalProofSet(input: ProofSetFingerprintInput): {
  readonly mint: string;
  readonly unit: string;
  readonly ys: readonly CompressedPoint[];
} {
  if (typeof input.mint !== 'string') invalidFingerprint('Mint URL is invalid');
  if (typeof input.unit !== 'string' || input.unit.length === 0) {
    invalidFingerprint('Unit must be a non-empty string');
  }
  if (!Array.isArray(input.ys)) invalidFingerprint('Proof Ys must be an array');

  const ys = input.ys.map(parseCompressedPoint);
  ys.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (let index = 1; index < ys.length; index += 1) {
    if (Buffer.compare(Buffer.from(ys[index - 1]!), Buffer.from(ys[index]!)) === 0) {
      throw new DeliveryValidationError(
        'DUPLICATE_PROOF_POINT',
        'Proof set cannot contain a duplicate Y',
      );
    }
  }

  return { mint: normalizeMintUrl(input.mint), unit: input.unit, ys };
}

function invalidFingerprint(message: string): never {
  throw new DeliveryValidationError('INVALID_FINGERPRINT_INPUT', message);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      invalidFingerprint(`${path} must contain only safe integer JSON numbers`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }

  if (!isPlainRecord(value)) {
    invalidFingerprint(`${path} must contain only JSON-compatible values`);
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      invalidFingerprint(`${path} must contain only string-keyed JSON objects`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
      invalidFingerprint(`${path}.${key} must contain only JSON-compatible values`);
    }
    assertJsonValue(descriptor.value, `${path}.${key}`);
  }
}

function assertCashuProof(value: unknown, index: number): asserts value is CashuProof {
  assertJsonValue(value, `proofs[${index}]`);
  if (
    !isPlainRecord(value) ||
    typeof value.amount !== 'number' ||
    !Number.isSafeInteger(value.amount) ||
    value.amount < 0 ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.secret !== 'string' ||
    value.secret.length === 0 ||
    typeof value.C !== 'string' ||
    value.C.length === 0 ||
    ('witness' in value && typeof value.witness !== 'string') ||
    ('dleq' in value && !isPlainRecord(value.dleq))
  ) {
    invalidFingerprint(`proofs[${index}] is not a valid Cashu proof`);
  }
}

function validatePayloadInput(input: PayloadFingerprintInput): void {
  if (!isPlainRecord(input)) invalidFingerprint('Payload fingerprint input is invalid');
  if (typeof input.requestId !== 'string') invalidFingerprint('Request ID is invalid');
  parseProtocolId(input.requestId);
  if (input.memo !== null && typeof input.memo !== 'string') {
    invalidFingerprint('Memo must be a string or null');
  }
  if (typeof input.mint !== 'string') invalidFingerprint('Mint URL is invalid');
  if (typeof input.unit !== 'string' || input.unit.length === 0) {
    invalidFingerprint('Unit must be a non-empty string');
  }
  if (!Array.isArray(input.proofs) || input.proofs.length > 256) {
    invalidFingerprint('Payload must contain at most 256 proofs');
  }
  input.proofs.forEach(assertCashuProof);
  if (!Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.expiresAt)) {
    invalidFingerprint('Delivery timestamps must be safe integers');
  }
  if (input.createdAt < 0 || input.expiresAt <= input.createdAt) {
    invalidFingerprint('Delivery expiry must be later than creation');
  }
  if (input.expiresAt - input.createdAt > 86_400) {
    invalidFingerprint('Delivery validity window cannot exceed 24 hours');
  }
}

function sha256Hex(encoded: Uint8Array): string {
  return createHash('sha256').update(encoded).digest('hex');
}

export function encodePayloadFingerprint(input: PayloadFingerprintInput): Uint8Array {
  validatePayloadInput(input);
  return Uint8Array.from(encode([
    'cashu-delivery-v1/payload',
    input.requestId,
    input.memo,
    normalizeMintUrl(input.mint),
    input.unit,
    input.proofs,
    1,
    input.createdAt,
    input.expiresAt,
  ], rfc8949EncodeOptions));
}

export function computePayloadHash(input: PayloadFingerprintInput): string {
  return sha256Hex(encodePayloadFingerprint(input));
}

export function encodeProofSetFingerprint(input: ProofSetFingerprintInput): Uint8Array {
  const { mint, unit, ys } = canonicalProofSet(input);
  return Uint8Array.from(
    encode(['cashu-delivery-v1/proof-set', mint, unit, ys], rfc8949EncodeOptions),
  );
}

export function computeProofSetHash(input: ProofSetFingerprintInput): string {
  return sha256Hex(encodeProofSetFingerprint(input));
}
