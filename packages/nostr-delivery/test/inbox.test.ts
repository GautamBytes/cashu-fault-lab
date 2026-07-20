import { getPublicKey } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { NostrDeliveryInbox, type GiftWrapSource } from '../src/index.js';

const receiverKey = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const receiverPubkey = getPublicKey(receiverKey);

function fakeSource(
  events: readonly { id: string; kind: number; created_at: number }[],
): GiftWrapSource {
  return {
    query: async () =>
      events.map((e) => ({
        ...e,
        pubkey: receiverPubkey,
        content: '',
        sig: '',
        tags: [],
      })),
  };
}

describe('NostrDeliveryInbox', () => {
  it('rejects less than one source', () => {
    expect(() => new NostrDeliveryInbox({ receiverPrivateKey: receiverKey, sources: [] })).toThrow(
      'from 1 to 32 relay sources',
    );
  });

  it('rejects more than 32 sources', () => {
    const sources = Array.from({ length: 33 }, () => fakeSource([]));
    expect(() => new NostrDeliveryInbox({ receiverPrivateKey: receiverKey, sources })).toThrow(
      'from 1 to 32 relay sources',
    );
  });

  it('rejects a negative lastSeen', async () => {
    const inbox = new NostrDeliveryInbox({
      receiverPrivateKey: receiverKey,
      sources: [fakeSource([])],
    });
    await expect(inbox.backfill({ lastSeen: -1 })).rejects.toThrow('is invalid');
  });

  it('rejects an unsafe integer lastSeen', async () => {
    const inbox = new NostrDeliveryInbox({
      receiverPrivateKey: receiverKey,
      sources: [fakeSource([])],
    });
    await expect(inbox.backfill({ lastSeen: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(
      'is invalid',
    );
  });

  it('rejects until before since', async () => {
    const inbox = new NostrDeliveryInbox({
      receiverPrivateKey: receiverKey,
      sources: [fakeSource([])],
    });
    await expect(inbox.backfill({ lastSeen: 1_000_000, until: 500_000 })).rejects.toThrow(
      'Inbox time range is invalid',
    );
  });

  it('backfills events from one source', async () => {
    const inbox = new NostrDeliveryInbox({
      receiverPrivateKey: receiverKey,
      sources: [fakeSource([{ id: 'ev1', kind: 1059, created_at: 1_000_000 }])],
    });
    // Non-gift-wrap events are silently skipped by unwrapDelivery
    const deliveries = await inbox.backfill({ lastSeen: 999_000 });
    expect(deliveries).toEqual([]);
  });

  it('rejects a maximumEvents value below 1', () => {
    expect(
      () =>
        new NostrDeliveryInbox({
          receiverPrivateKey: receiverKey,
          sources: [fakeSource([])],
          maximumEvents: 0,
        }),
    ).toThrow('event limit is invalid');
  });

  it('rejects a maximumEvents value above 100000', () => {
    expect(
      () =>
        new NostrDeliveryInbox({
          receiverPrivateKey: receiverKey,
          sources: [fakeSource([])],
          maximumEvents: 100_001,
        }),
    ).toThrow('event limit is invalid');
  });
});
