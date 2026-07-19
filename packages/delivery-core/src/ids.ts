import { randomBytes } from 'node:crypto';
import { DeliveryValidationError } from './errors.js';

export type ProtocolId = string & { readonly ProtocolId: unique symbol };
export type RandomBytes = (size: number) => Uint8Array;

const PROTOCOL_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function parseProtocolId(value: string): ProtocolId {
  if (!PROTOCOL_ID_PATTERN.test(value)) {
    throw new DeliveryValidationError('INVALID_PROTOCOL_ID', 'Protocol ID must encode 16 bytes');
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 16 || decoded.toString('base64url') !== value) {
    throw new DeliveryValidationError('INVALID_PROTOCOL_ID', 'Protocol ID must encode 16 bytes');
  }

  return value as ProtocolId;
}

export function generateProtocolId(source: RandomBytes = (size) => randomBytes(size)): ProtocolId {
  const bytes = source(16);
  if (bytes.length !== 16) {
    throw new DeliveryValidationError(
      'INVALID_RANDOM_SOURCE',
      'Random source must return 16 bytes',
    );
  }

  return parseProtocolId(Buffer.from(bytes).toString('base64url'));
}
