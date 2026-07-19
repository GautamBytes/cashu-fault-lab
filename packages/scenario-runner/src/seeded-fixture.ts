import { parseProtocolId, type ProtocolId } from '@cashu-fault-lab/delivery-core';
import { createHash } from 'node:crypto';

function seededBytes(seed: string, label: string): Buffer {
  if (seed.length === 0) throw new Error('Fixture seed is required');
  return createHash('sha256')
    .update('cashu-fault-lab/scenario-fixture-v1\0')
    .update(seed)
    .update('\0')
    .update(label)
    .digest();
}

export function seededProtocolId(seed: string, label: string): ProtocolId {
  return parseProtocolId(seededBytes(seed, label).subarray(0, 16).toString('base64url'));
}

export function seededSecret(seed: string, label: string): string {
  return seededBytes(seed, label).toString('base64url');
}

export function seededPrivateKey(seed: string, label: string): Uint8Array {
  const value = seededBytes(seed, label);
  if (value.every((byte) => byte === 0)) value[31] = 1;
  return Uint8Array.from(value);
}
