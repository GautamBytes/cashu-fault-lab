import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  nip44,
  type Event,
  type UnsignedEvent,
} from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  NostrDeliveryInbox,
  unwrapDelivery,
  wrapDelivery,
  type GiftWrapSource,
} from '../src/index.js';

const senderKey = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const receiverKey = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const wrapperKey = Uint8Array.from(Buffer.from('33'.repeat(32), 'hex'));
const otherWrapperKey = Uint8Array.from(Buffer.from('44'.repeat(32), 'hex'));
const receiverPubkey = getPublicKey(receiverKey);
const payload = new TextEncoder().encode('{"delivery":{"id":"logical-payment"}}');

function conversationKey(privateKey: Uint8Array, publicKey: string): Uint8Array {
  return nip44.v2.utils.getConversationKey(privateKey, publicKey);
}

function mismatchWrap(): Event {
  const senderPubkey = getPublicKey(senderKey);
  const rumor = {
    kind: 14,
    created_at: 2_000_000,
    pubkey: getPublicKey(otherWrapperKey),
    tags: [['p', receiverPubkey]],
    content: new TextDecoder().decode(payload),
  } satisfies UnsignedEvent;
  const mismatchedRumor = { ...rumor, id: getEventHash(rumor) };
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: 1_999_999,
      tags: [],
      content: nip44.v2.encrypt(
        JSON.stringify(mismatchedRumor),
        conversationKey(senderKey, receiverPubkey),
      ),
    },
    senderKey,
  );
  expect(seal.pubkey).toBe(senderPubkey);
  return finalizeEvent(
    {
      kind: 1059,
      created_at: 1_999_998,
      tags: [['p', receiverPubkey]],
      content: nip44.v2.encrypt(JSON.stringify(seal), conversationKey(wrapperKey, receiverPubkey)),
    },
    wrapperKey,
  );
}

describe('NIP-17/NIP-59 Cashu delivery', () => {
  it('round-trips exact payload bytes through a verified rumor, seal, and gift wrap', () => {
    const wrapped = wrapDelivery(payload, {
      senderPrivateKey: senderKey,
      receiverPublicKey: receiverPubkey,
      now: 2_000_000,
      randomSecretKey: () => wrapperKey,
      randomOffsetSeconds: (layer) => (layer === 'seal' ? 10 : 20),
    });

    const unwrapped = unwrapDelivery(wrapped, receiverKey);

    expect(unwrapped.payloadBytes).toEqual(payload);
    expect(unwrapped.senderPublicKey).toBe(getPublicKey(senderKey));
    expect(unwrapped.receiverPublicKey).toBe(receiverPubkey);
    expect(wrapped.kind).toBe(1059);
    expect(wrapped.tags).toEqual([['p', receiverPubkey]]);
  });

  it('uses a fresh one-time wrapper key on every retry while preserving payload bytes', () => {
    const keys = [wrapperKey, otherWrapperKey];
    const wrapped = keys.map((key) =>
      wrapDelivery(payload, {
        senderPrivateKey: senderKey,
        receiverPublicKey: receiverPubkey,
        now: 2_000_000,
        randomSecretKey: () => key,
        randomOffsetSeconds: () => 1,
      }),
    );

    expect(new Set(wrapped.map((event) => event.pubkey)).size).toBe(2);
    expect(wrapped.map((event) => unwrapDelivery(event, receiverKey).payloadBytes)).toEqual([
      payload,
      payload,
    ]);
  });

  it('rejects invalid signatures, recipient tags, and seal/rumor impersonation', () => {
    const wrapped = wrapDelivery(payload, {
      senderPrivateKey: senderKey,
      receiverPublicKey: receiverPubkey,
      now: 2_000_000,
      randomSecretKey: () => wrapperKey,
      randomOffsetSeconds: () => 1,
    });

    expect(() => unwrapDelivery({ ...wrapped, sig: '00'.repeat(64) }, receiverKey)).toThrowError(
      /signature/i,
    );
    const wrongRecipient = finalizeEvent(
      {
        kind: wrapped.kind,
        created_at: wrapped.created_at,
        tags: [],
        content: wrapped.content,
      },
      wrapperKey,
    );
    expect(() => unwrapDelivery(wrongRecipient, receiverKey)).toThrowError(/recipient/i);
    expect(() => unwrapDelivery(mismatchWrap(), receiverKey)).toThrowError(/pubkey|imperson/i);
  });

  it('deduplicates multi-relay history and overlaps by the full two-day timestamp window', async () => {
    const wrapped = wrapDelivery(payload, {
      senderPrivateKey: senderKey,
      receiverPublicKey: receiverPubkey,
      now: 200_000,
      randomSecretKey: () => wrapperKey,
      randomOffsetSeconds: () => 100,
    });
    const filters: unknown[] = [];
    const source = (events: readonly Event[]): GiftWrapSource => ({
      query: async (filter) => {
        filters.push(filter);
        return events;
      },
    });
    const inbox = new NostrDeliveryInbox({
      receiverPrivateKey: receiverKey,
      sources: [source([wrapped]), source([wrapped, { ...wrapped, sig: '00'.repeat(64) }])],
    });

    const deliveries = await inbox.backfill({ lastSeen: 200_000 });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.payloadBytes).toEqual(payload);
    expect(filters).toEqual([
      { kinds: [1059], '#p': [receiverPubkey], since: 27_200 },
      { kinds: [1059], '#p': [receiverPubkey], since: 27_200 },
    ]);
  });

  it('counts only unique wrap ids against the inbox event limit', async () => {
    const wrapped = wrapDelivery(payload, {
      senderPrivateKey: senderKey,
      receiverPublicKey: receiverPubkey,
      now: 200_000,
      randomSecretKey: () => wrapperKey,
      randomOffsetSeconds: () => 100,
    });
    const source: GiftWrapSource = { query: async () => [wrapped, wrapped, wrapped] };
    const inbox = new NostrDeliveryInbox({
      receiverPrivateKey: receiverKey,
      sources: [source],
      maximumEvents: 1,
    });

    await expect(inbox.backfill({ lastSeen: 200_000 })).resolves.toHaveLength(1);
  });

  it('uses available relay history when another relay is offline', async () => {
    const wrapped = wrapDelivery(payload, {
      senderPrivateKey: senderKey,
      receiverPublicKey: receiverPubkey,
      now: 200_000,
      randomSecretKey: () => wrapperKey,
      randomOffsetSeconds: () => 100,
    });
    const offline: GiftWrapSource = {
      query: async () => {
        throw new Error('relay offline');
      },
    };
    const available: GiftWrapSource = { query: async () => [wrapped] };
    const inbox = new NostrDeliveryInbox({
      receiverPrivateKey: receiverKey,
      sources: [offline, available],
    });

    await expect(inbox.backfill({ lastSeen: 200_000 })).resolves.toHaveLength(1);
  });
});
