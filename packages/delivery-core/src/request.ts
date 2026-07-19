import { DeliveryValidationError } from './errors.js';

export interface DeliveryNegotiation {
  readonly version: 1;
  readonly expiresAt: number;
}

function invalidNegotiation(message: string): never {
  throw new DeliveryValidationError('INVALID_DELIVERY_NEGOTIATION', message);
}

function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    invalidNegotiation('Current time must be a nonnegative safe integer');
  }
}

export function parseDeliveryNegotiation(
  value: unknown,
  now: number,
): DeliveryNegotiation | undefined {
  assertNow(now);
  if (!Array.isArray(value)) invalidNegotiation('Transport tags must be an array');

  const deliveryVersions: string[] = [];
  const expiries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalidNegotiation('Transport tags must not contain holes');
    const tag = value[index];
    if (!Array.isArray(tag) || tag.length < 2) {
      invalidNegotiation('Every transport tag must contain a name and value');
    }
    for (let itemIndex = 0; itemIndex < tag.length; itemIndex += 1) {
      if (!Object.hasOwn(tag, itemIndex) || typeof tag[itemIndex] !== 'string') {
        invalidNegotiation('Transport tag values must be strings');
      }
    }
    if (tag[0] === 'delivery') deliveryVersions.push(tag[1]!);
    if (tag[0] === 'expires_at') expiries.push(tag[1]!);
  }

  if (deliveryVersions.length === 0) return undefined;
  if (deliveryVersions.length !== 1) invalidNegotiation('Duplicate delivery tags are invalid');
  if (deliveryVersions[0] !== '1') return undefined;
  if (expiries.length !== 1) invalidNegotiation('Version-one delivery requires exactly one expiry');

  const expiryText = expiries[0]!;
  if (!/^(0|[1-9][0-9]*)$/.test(expiryText)) {
    invalidNegotiation('Delivery expiry must be a canonical Unix timestamp');
  }
  const expiresAt = Number(expiryText);
  if (!Number.isSafeInteger(expiresAt))
    invalidNegotiation('Delivery expiry must be a safe integer');
  if (expiresAt <= now) {
    throw new DeliveryValidationError('DELIVERY_EXPIRED', 'Delivery request has expired');
  }
  if (expiresAt - now > 86_400) {
    invalidNegotiation('Delivery expiry cannot be more than 24 hours away');
  }

  return { version: 1, expiresAt };
}
