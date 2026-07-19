import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip44,
  verifyEvent,
  type Event,
  type EventTemplate,
  type UnsignedEvent,
} from 'nostr-tools';
import { randomBytes, randomInt } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';

const TWO_DAYS = 172_800;
const MAX_DELIVERY_BYTES = 65_536;
const MAX_ENCRYPTED_CONTENT_CHARS = 2_097_152;

type WrapperLayer = 'seal' | 'wrap';

export interface WrapDeliveryOptions {
  readonly senderPrivateKey: Uint8Array;
  readonly receiverPublicKey: string;
  readonly now: number;
  readonly relayUrl?: string;
  readonly randomSecretKey?: () => Uint8Array;
  readonly randomNonce?: (layer: WrapperLayer) => Uint8Array;
  readonly randomOffsetSeconds?: (layer: WrapperLayer) => number;
}

export interface UnwrappedDelivery {
  readonly payloadBytes: Uint8Array;
  readonly senderPublicKey: string;
  readonly receiverPublicKey: string;
  readonly rumorId: string;
  readonly createdAt: number;
  readonly wrapId: string;
}

interface Rumor extends UnsignedEvent {
  readonly id: string;
}

function assertTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`);
}

function assertHexPublicKey(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is invalid`);
}

function nonce(value: Uint8Array, layer: WrapperLayer): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error(`${layer} NIP-44 nonce must be 32 bytes`);
  }
  return Uint8Array.from(value);
}

function offset(value: number, layer: WrapperLayer): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > TWO_DAYS) {
    throw new Error(`${layer} timestamp offset must be from 0 to 172800 seconds`);
  }
  return value;
}

function conversationKey(privateKey: Uint8Array, publicKey: string): Uint8Array {
  return nip44.v2.utils.getConversationKey(privateKey, publicKey);
}

function eventJson(value: unknown, name: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value)) as unknown;
  } catch {
    throw new Error(`${name} is invalid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} is not an event`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function tags(value: unknown, name: string): string[][] {
  if (
    !Array.isArray(value) ||
    value.some((tag) => !Array.isArray(tag) || tag.some((item) => typeof item !== 'string'))
  ) {
    throw new Error(`${name} tags are invalid`);
  }
  return value.map((tag) => [...tag]);
}

function signedEvent(value: unknown, name: string): Event {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not an event`);
  }
  const input = value as Readonly<Record<string, unknown>>;
  if (
    typeof input.id !== 'string' ||
    typeof input.pubkey !== 'string' ||
    typeof input.sig !== 'string' ||
    typeof input.content !== 'string' ||
    typeof input.kind !== 'number' ||
    typeof input.created_at !== 'number'
  ) {
    throw new Error(`${name} fields are invalid`);
  }
  assertTime(input.kind, `${name} kind`);
  assertTime(input.created_at, `${name} timestamp`);
  const event: Event = {
    id: input.id,
    pubkey: input.pubkey,
    sig: input.sig,
    content: input.content,
    kind: input.kind,
    created_at: input.created_at,
    tags: tags(input.tags, name),
  };
  if (!verifyEvent(event)) throw new Error(`${name} signature is invalid`);
  return event;
}

function rumorEvent(value: unknown): Rumor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Rumor is not an event');
  }
  const input = value as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(input, 'sig')) throw new Error('Rumor must be unsigned');
  if (
    typeof input.id !== 'string' ||
    typeof input.pubkey !== 'string' ||
    typeof input.content !== 'string' ||
    typeof input.kind !== 'number' ||
    typeof input.created_at !== 'number'
  ) {
    throw new Error('Rumor fields are invalid');
  }
  assertTime(input.kind, 'Rumor kind');
  assertTime(input.created_at, 'Rumor timestamp');
  const unsigned: UnsignedEvent = {
    pubkey: input.pubkey,
    content: input.content,
    kind: input.kind,
    created_at: input.created_at,
    tags: tags(input.tags, 'Rumor'),
  };
  if (getEventHash(unsigned) !== input.id) throw new Error('Rumor ID is invalid');
  return { ...unsigned, id: input.id };
}

function recipientTag(event: Pick<Event | Rumor, 'tags'>, receiverPublicKey: string): void {
  const recipients = event.tags.filter((tag) => tag[0] === 'p');
  if (!recipients.some((tag) => tag[1] === receiverPublicKey)) {
    throw new Error('NIP-17 recipient tag does not match this receiver');
  }
}

function decryptJson(event: Event, receiverPrivateKey: Uint8Array, name: string): unknown {
  if (event.content.length > MAX_ENCRYPTED_CONTENT_CHARS) {
    throw new Error(`${name} encrypted content is too large`);
  }
  let plaintext: string;
  try {
    plaintext = nip44.v2.decrypt(event.content, conversationKey(receiverPrivateKey, event.pubkey));
  } catch (error) {
    throw new Error(`${name} NIP-44 decryption failed`, { cause: error });
  }
  return eventJson(plaintext, name);
}

export function wrapDelivery(payloadBytes: Uint8Array, options: WrapDeliveryOptions): Event {
  if (!(payloadBytes instanceof Uint8Array) || payloadBytes.byteLength < 1) {
    throw new Error('Delivery payload must be non-empty bytes');
  }
  if (payloadBytes.byteLength > MAX_DELIVERY_BYTES)
    throw new Error('Delivery payload is too large');
  assertTime(options.now, 'Current Nostr time');
  assertHexPublicKey(options.receiverPublicKey, 'Receiver public key');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
  } catch {
    throw new Error('Delivery payload must be valid UTF-8');
  }
  if (!Buffer.from(new TextEncoder().encode(content)).equals(Buffer.from(payloadBytes))) {
    throw new Error('Delivery payload cannot round-trip as NIP-17 plain text');
  }

  const senderPublicKey = getPublicKey(options.senderPrivateKey);
  const rumorTemplate: UnsignedEvent = {
    pubkey: senderPublicKey,
    kind: 14,
    created_at: options.now,
    content,
    tags: [
      options.relayUrl
        ? ['p', options.receiverPublicKey, options.relayUrl]
        : ['p', options.receiverPublicKey],
    ],
  };
  const rumor: Rumor = { ...rumorTemplate, id: getEventHash(rumorTemplate) };
  const randomOffset = options.randomOffsetSeconds ?? (() => randomInt(TWO_DAYS + 1));
  const randomNonce = options.randomNonce ?? (() => randomBytes(32));
  const sealTemplate: EventTemplate = {
    kind: 13,
    created_at: Math.max(0, options.now - offset(randomOffset('seal'), 'seal')),
    tags: [],
    content: nip44.v2.encrypt(
      JSON.stringify(rumor),
      conversationKey(options.senderPrivateKey, options.receiverPublicKey),
      nonce(randomNonce('seal'), 'seal'),
    ),
  };
  const seal = finalizeEvent(sealTemplate, options.senderPrivateKey);
  const wrapperPrivateKey = (options.randomSecretKey ?? generateSecretKey)();
  const wrapperPublicKey = getPublicKey(wrapperPrivateKey);
  if (wrapperPublicKey === senderPublicKey || wrapperPublicKey === options.receiverPublicKey) {
    throw new Error('Gift-wrap key must be fresh and one-time');
  }
  return finalizeEvent(
    {
      kind: 1059,
      created_at: Math.max(0, options.now - offset(randomOffset('wrap'), 'wrap')),
      tags: [['p', options.receiverPublicKey]],
      content: nip44.v2.encrypt(
        JSON.stringify(seal),
        conversationKey(wrapperPrivateKey, options.receiverPublicKey),
        nonce(randomNonce('wrap'), 'wrap'),
      ),
    },
    wrapperPrivateKey,
  );
}

export function unwrapDelivery(value: Event, receiverPrivateKey: Uint8Array): UnwrappedDelivery {
  const receiverPublicKey = getPublicKey(receiverPrivateKey);
  const wrap = signedEvent(value, 'Gift wrap');
  if (wrap.kind !== 1059) throw new Error('Gift wrap kind must be 1059');
  recipientTag(wrap, receiverPublicKey);
  const seal = signedEvent(decryptJson(wrap, receiverPrivateKey, 'Seal'), 'Seal');
  if (seal.kind !== 13 || seal.tags.length !== 0) {
    throw new Error('Seal must be kind 13 with no tags');
  }
  const rumor = rumorEvent(decryptJson(seal, receiverPrivateKey, 'Rumor'));
  if (rumor.kind !== 14) throw new Error('Delivery rumor kind must be 14');
  if (seal.pubkey !== rumor.pubkey) {
    throw new Error('Seal and rumor pubkeys differ; sender impersonation rejected');
  }
  recipientTag(rumor, receiverPublicKey);
  const payloadBytes = new TextEncoder().encode(rumor.content);
  if (payloadBytes.byteLength > MAX_DELIVERY_BYTES)
    throw new Error('Delivery payload is too large');
  return {
    payloadBytes,
    senderPublicKey: rumor.pubkey,
    receiverPublicKey,
    rumorId: rumor.id,
    createdAt: rumor.created_at,
    wrapId: wrap.id,
  };
}

export { TWO_DAYS as NIP17_TIMESTAMP_OVERLAP_SECONDS };
