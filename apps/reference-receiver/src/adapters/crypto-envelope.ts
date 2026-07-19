import { createCipheriv, createDecipheriv, randomBytes as secureRandomBytes } from 'node:crypto';

export type EnvelopeRandomBytes = (size: number) => Uint8Array;

export interface EncryptedEnvelope {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
}

export class CryptoEnvelope {
  readonly #key: Buffer;
  readonly #randomBytes: EnvelopeRandomBytes;

  constructor(
    key: Uint8Array,
    randomBytes: EnvelopeRandomBytes = (size) => secureRandomBytes(size),
  ) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
      throw new Error('Envelope key must contain exactly 32 bytes');
    }
    this.#key = Buffer.from(key);
    this.#randomBytes = randomBytes;
  }

  encrypt(value: unknown, authenticatedData: Uint8Array): EncryptedEnvelope {
    const nonce = this.#randomBytes(12);
    if (nonce.byteLength !== 12) throw new Error('Envelope random source must return 12 bytes');
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(authenticatedData);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ciphertext,
      nonce: Uint8Array.from(nonce),
      tag: Uint8Array.from(cipher.getAuthTag()),
    };
  }

  decrypt<T>(envelope: EncryptedEnvelope, authenticatedData: Uint8Array): T {
    try {
      if (envelope.nonce.byteLength !== 12 || envelope.tag.byteLength !== 16) {
        throw new Error('invalid envelope dimensions');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.#key, envelope.nonce);
      decipher.setAAD(authenticatedData);
      decipher.setAuthTag(Buffer.from(envelope.tag));
      const plaintext = Buffer.concat([
        decipher.update(envelope.ciphertext),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(plaintext) as T;
    } catch {
      throw new Error('Unable to decrypt or authenticate receiver state');
    }
  }
}

export function swapPlanAuthenticatedData(input: {
  readonly requestId: string;
  readonly deliveryId: string;
  readonly payloadHash: string;
}): Uint8Array {
  return Buffer.from(
    JSON.stringify([
      'cashu-fault-lab/swap-plan-v1',
      input.requestId,
      input.deliveryId,
      input.payloadHash,
    ]),
    'utf8',
  );
}

export function replacementAuthenticatedData(input: {
  readonly requestId: string;
  readonly deliveryId: string;
  readonly payloadHash: string;
  readonly replacementPlanHash: string;
}): Uint8Array {
  return Buffer.from(
    JSON.stringify([
      'cashu-fault-lab/replacement-proofs-v1',
      input.requestId,
      input.deliveryId,
      input.payloadHash,
      input.replacementPlanHash,
    ]),
    'utf8',
  );
}
