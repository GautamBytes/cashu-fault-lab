import { getPublicKey, type Event } from 'nostr-tools';
import {
  NIP17_TIMESTAMP_OVERLAP_SECONDS,
  unwrapDelivery,
  type UnwrappedDelivery,
} from './gift-wrap.js';

export interface GiftWrapFilter {
  readonly kinds: readonly [1059];
  readonly '#p': readonly [string];
  readonly since: number;
  readonly until?: number;
}

export interface GiftWrapSource {
  query(filter: GiftWrapFilter): Promise<readonly Event[]>;
}

export interface NostrDeliveryInboxOptions {
  readonly receiverPrivateKey: Uint8Array;
  readonly sources: readonly GiftWrapSource[];
  readonly maximumEvents?: number;
}

export interface BackfillInput {
  readonly lastSeen: number;
  readonly until?: number;
}

function time(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`);
  return value;
}

export class NostrDeliveryInbox {
  readonly #receiverPrivateKey: Uint8Array;
  readonly #receiverPublicKey: string;
  readonly #sources: readonly GiftWrapSource[];
  readonly #maximumEvents: number;

  constructor(options: NostrDeliveryInboxOptions) {
    this.#receiverPrivateKey = Uint8Array.from(options.receiverPrivateKey);
    this.#receiverPublicKey = getPublicKey(this.#receiverPrivateKey);
    this.#sources = [...options.sources];
    if (this.#sources.length < 1 || this.#sources.length > 32) {
      throw new Error('Nostr inbox needs from 1 to 32 relay sources');
    }
    this.#maximumEvents = options.maximumEvents ?? 10_000;
    if (
      !Number.isSafeInteger(this.#maximumEvents) ||
      this.#maximumEvents < 1 ||
      this.#maximumEvents > 100_000
    ) {
      throw new Error('Nostr inbox event limit is invalid');
    }
  }

  async backfill(input: BackfillInput): Promise<readonly UnwrappedDelivery[]> {
    const lastSeen = time(input.lastSeen, 'Inbox checkpoint');
    const since = Math.max(0, lastSeen - NIP17_TIMESTAMP_OVERLAP_SECONDS);
    const until = input.until === undefined ? undefined : time(input.until, 'Inbox upper bound');
    if (until !== undefined && until < since) throw new Error('Inbox time range is invalid');
    const filter: GiftWrapFilter = {
      kinds: [1059],
      '#p': [this.#receiverPublicKey],
      since,
      ...(until === undefined ? {} : { until }),
    };
    const queried = await Promise.allSettled(this.#sources.map((source) => source.query(filter)));
    const responses = queried
      .filter(
        (result): result is PromiseFulfilledResult<readonly Event[]> =>
          result.status === 'fulfilled',
      )
      .map((result) => result.value);
    if (responses.length === 0) throw new Error('All Nostr inbox relay queries failed');
    const events = new Map<string, Event>();
    for (const event of responses.flat()) {
      if (typeof event.id !== 'string' || events.has(event.id)) continue;
      if (events.size >= this.#maximumEvents) throw new Error('Nostr inbox event limit exceeded');
      events.set(event.id, event);
    }
    const deliveries = new Map<string, UnwrappedDelivery>();
    for (const event of events.values()) {
      try {
        const delivery = unwrapDelivery(event, this.#receiverPrivateKey);
        deliveries.set(delivery.rumorId, delivery);
      } catch {}
    }
    return [...deliveries.values()].sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.rumorId.localeCompare(right.rumorId),
    );
  }
}
