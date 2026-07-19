import { TextDecoder, TextEncoder } from 'node:util';
import { DeliveryValidationError } from './errors.js';
import { computePayloadHash, type CashuProof } from './fingerprint.js';
import { parseProtocolId, type ProtocolId } from './ids.js';
import { normalizeMintUrl } from './mint-url.js';

const MAX_PAYLOAD_BYTES = 65_536;
const CLOCK_SKEW_SECONDS = 60;

export interface DeliveryPayload {
  readonly id: ProtocolId;
  readonly memo: string | null;
  readonly mint: string;
  readonly unit: string;
  readonly proofs: readonly CashuProof[];
  readonly delivery: {
    readonly version: 1;
    readonly id: ProtocolId;
    readonly createdAt: number;
    readonly expiresAt: number;
  };
}

export interface DeliveryPayloadWire {
  readonly id: string;
  readonly memo?: string | null;
  readonly mint: string;
  readonly unit: string;
  readonly proofs: readonly CashuProof[];
  readonly delivery: {
    readonly v: 1;
    readonly id: string;
    readonly created_at: number;
    readonly expires_at: number;
  };
}

function invalidPayload(message: string): never {
  throw new DeliveryValidationError('INVALID_DELIVERY_PAYLOAD', message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeTime(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidPayload(`${name} must be a nonnegative safe integer`);
  }
}

export function parseDeliveryPayload(value: unknown, now: number): DeliveryPayload {
  assertSafeTime(now, 'Current time');
  if (!isRecord(value) || !isRecord(value.delivery)) invalidPayload('Delivery payload is invalid');
  if (typeof value.id !== 'string') invalidPayload('Request ID is invalid');
  if (value.memo !== undefined && value.memo !== null && typeof value.memo !== 'string') {
    invalidPayload('Memo must be a string or null');
  }
  if (typeof value.mint !== 'string') invalidPayload('Mint URL is invalid');
  if (typeof value.unit !== 'string' || value.unit.length === 0) {
    invalidPayload('Unit must be a non-empty string');
  }
  if (!Array.isArray(value.proofs) || value.proofs.length > 256) {
    invalidPayload('Delivery payload must contain at most 256 proofs');
  }

  const delivery = value.delivery;
  if (delivery.v !== 1) invalidPayload('Delivery version must be 1');
  if (typeof delivery.id !== 'string') invalidPayload('Delivery ID is invalid');
  assertSafeTime(delivery.created_at, 'Delivery creation time');
  assertSafeTime(delivery.expires_at, 'Delivery expiry');
  if (delivery.expires_at <= delivery.created_at) {
    invalidPayload('Delivery expiry must be later than creation');
  }
  if (delivery.expires_at - delivery.created_at > 86_400) {
    invalidPayload('Delivery validity window cannot exceed 24 hours');
  }
  if (delivery.created_at > now + CLOCK_SKEW_SECONDS) {
    invalidPayload('Delivery creation time is too far in the future');
  }
  if (delivery.expires_at < now - CLOCK_SKEW_SECONDS) {
    throw new DeliveryValidationError('DELIVERY_EXPIRED', 'Delivery payload has expired');
  }

  const payload: DeliveryPayload = {
    id: parseProtocolId(value.id),
    memo: value.memo ?? null,
    mint: normalizeMintUrl(value.mint),
    unit: value.unit,
    proofs: value.proofs as readonly CashuProof[],
    delivery: {
      version: 1,
      id: parseProtocolId(delivery.id),
      createdAt: delivery.created_at,
      expiresAt: delivery.expires_at,
    },
  };

  computePayloadHash({
    requestId: payload.id,
    memo: payload.memo,
    mint: payload.mint,
    unit: payload.unit,
    proofs: payload.proofs,
    createdAt: payload.delivery.createdAt,
    expiresAt: payload.delivery.expiresAt,
  });
  return payload;
}

export function serializeDeliveryPayload(payload: DeliveryPayload): Uint8Array {
  const validated = parseDeliveryPayload(
    {
      id: payload.id,
      memo: payload.memo,
      mint: payload.mint,
      unit: payload.unit,
      proofs: payload.proofs,
      delivery: {
        v: payload.delivery.version,
        id: payload.delivery.id,
        created_at: payload.delivery.createdAt,
        expires_at: payload.delivery.expiresAt,
      },
    },
    payload.delivery.createdAt,
  );
  const wire: DeliveryPayloadWire = {
    id: validated.id,
    memo: validated.memo,
    mint: validated.mint,
    unit: validated.unit,
    proofs: validated.proofs,
    delivery: {
      v: 1,
      id: validated.delivery.id,
      created_at: validated.delivery.createdAt,
      expires_at: validated.delivery.expiresAt,
    },
  };
  const encoded = new TextEncoder().encode(JSON.stringify(wire));
  if (encoded.length > MAX_PAYLOAD_BYTES) invalidPayload('Payload exceeds 65,536 bytes');
  return encoded;
}

export function parseDeliveryPayloadJson(value: Uint8Array, now: number): DeliveryPayload {
  if (!(value instanceof Uint8Array)) invalidPayload('Encoded payload must be bytes');
  if (value.byteLength > MAX_PAYLOAD_BYTES) invalidPayload('Payload exceeds 65,536 bytes');

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    invalidPayload('Payload must be valid UTF-8');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    invalidPayload('Payload must be valid JSON');
  }
  return parseDeliveryPayload(decoded, now);
}
