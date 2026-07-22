import { DeliveryValidationError, serializeDeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import {
  NIP17_TIMESTAMP_OVERLAP_SECONDS,
  NostrRelayClient,
  normalizeRelayUrl,
  unwrapDelivery,
  wrapDelivery,
  type GiftWrapFilter,
  type GiftWrapSource,
  type RelayPublishResult,
  type WrapDeliveryOptions,
} from '@cashu-fault-lab/nostr-delivery';
import {
  acceptPayloadBytes,
  type AcceptDeliveryDependencies,
  ReceiverDomainError,
} from '@cashu-fault-lab/reference-receiver';
import { getPublicKey, nip19, type Event } from 'nostr-tools';

type ReceiptEvent = ReturnType<typeof wrapDelivery>;

export type CashuTsNostrReceiverPublish = (
  relayUrl: string,
  event: ReceiptEvent,
) => Promise<RelayPublishResult>;

export interface CashuTsNostrReceiverOptions {
  readonly receiverPrivateKey: Uint8Array;
  readonly relayUrls: readonly string[];
  readonly accept: AcceptDeliveryDependencies;
  readonly now: () => number;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maximumEvents?: number;
  readonly source?: (relayUrl: string) => GiftWrapSource;
  readonly publish?: CashuTsNostrReceiverPublish;
  readonly randomSecretKey?: WrapDeliveryOptions['randomSecretKey'];
  readonly randomNonce?: WrapDeliveryOptions['randomNonce'];
  readonly randomOffsetSeconds?: WrapDeliveryOptions['randomOffsetSeconds'];
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function key(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error('Nostr receiver private key must contain exactly 32 bytes');
  }
  return Uint8Array.from(value);
}

function isTerminalProcessingError(error: unknown): boolean {
  return error instanceof DeliveryValidationError || error instanceof ReceiverDomainError;
}

export class CashuTsNostrReceiver {
  readonly #receiverPrivateKey: Uint8Array;
  readonly #receiverPublicKey: string;
  readonly #relayUrls: readonly string[];
  readonly #accept: AcceptDeliveryDependencies;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #source: (relayUrl: string) => GiftWrapSource;
  readonly #publish: CashuTsNostrReceiverPublish;
  readonly #randomSecretKey: WrapDeliveryOptions['randomSecretKey'];
  readonly #randomNonce: WrapDeliveryOptions['randomNonce'];
  readonly #randomOffsetSeconds: WrapDeliveryOptions['randomOffsetSeconds'];
  readonly #processedEventIds = new Set<string>();
  #lastSeen: number;
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<void> | undefined;

  constructor(options: CashuTsNostrReceiverOptions) {
    this.#receiverPrivateKey = key(options.receiverPrivateKey);
    this.#receiverPublicKey = getPublicKey(this.#receiverPrivateKey);
    this.#relayUrls = [...new Set(options.relayUrls.map(normalizeRelayUrl))];
    if (this.#relayUrls.length < 1 || this.#relayUrls.length > 16) {
      throw new Error('Nostr receiver needs from 1 to 16 relay URLs');
    }
    if (this.#relayUrls.length !== options.relayUrls.length) {
      throw new Error('Nostr receiver relay URLs must be unique');
    }
    this.#accept = options.accept;
    this.#now = options.now;
    this.#pollIntervalMs = boundedInteger(
      options.pollIntervalMs ?? 100,
      'Nostr receiver poll interval',
      1,
      300_000,
    );
    const timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 'Nostr timeout', 1, 300_000);
    this.#source =
      options.source ??
      ((relayUrl) =>
        new NostrRelayClient({
          relayUrl,
          timeoutMs,
          ...(options.maximumEvents === undefined ? {} : { maximumEvents: options.maximumEvents }),
        }));
    this.#publish =
      options.publish ??
      ((relayUrl, event) => new NostrRelayClient({ relayUrl, timeoutMs }).publish(event));
    this.#randomSecretKey = options.randomSecretKey;
    this.#randomNonce = options.randomNonce;
    this.#randomOffsetSeconds = options.randomOffsetSeconds;
    this.#lastSeen = this.#safeNow();
  }

  get target(): string {
    return nip19.nprofileEncode({
      pubkey: this.#receiverPublicKey,
      relays: [...this.#relayUrls],
    });
  }

  reset(): void {
    this.#processedEventIds.clear();
    this.#lastSeen = this.#safeNow();
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.poll().catch(() => {});
    }, this.#pollIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async poll(): Promise<void> {
    if (this.#polling !== undefined) return this.#polling;
    this.#polling = this.#pollOnce();
    try {
      await this.#polling;
    } finally {
      this.#polling = undefined;
    }
  }

  async #pollOnce(): Promise<void> {
    const filter: GiftWrapFilter = {
      kinds: [1059],
      '#p': [this.#receiverPublicKey],
      since: Math.max(0, this.#lastSeen - NIP17_TIMESTAMP_OVERLAP_SECONDS),
    };
    const queried = await Promise.allSettled(
      this.#relayUrls.map((relayUrl) => this.#source(relayUrl).query(filter)),
    );
    const fulfilled = queried.filter(
      (result): result is PromiseFulfilledResult<readonly Event[]> => result.status === 'fulfilled',
    );
    if (fulfilled.length === 0) throw new Error('All Nostr receiver relay queries failed');
    const events = new Map<string, Event>();
    for (const result of fulfilled) {
      for (const event of result.value) {
        if (!this.#processedEventIds.has(event.id)) events.set(event.id, event);
      }
    }
    for (const event of [...events.values()].sort(
      (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
    )) {
      await this.#process(event);
      this.#lastSeen = Math.max(this.#lastSeen, event.created_at);
    }
  }

  async #process(event: Event): Promise<void> {
    let receipt: ReceiptEvent;
    const replyRelayUrl = this.#relayUrls[0];
    if (replyRelayUrl === undefined) throw new Error('Nostr receiver relay list is empty');
    let request: ReturnType<typeof unwrapDelivery>;
    try {
      request = unwrapDelivery(event, this.#receiverPrivateKey);
    } catch {
      this.#processedEventIds.add(event.id);
      return;
    }
    try {
      const accepted = await acceptPayloadBytes(request.payloadBytes, this.#accept);
      const receiptBytes = new TextEncoder().encode(
        JSON.stringify(serializeDeliveryReceipt(accepted)),
      );
      receipt = wrapDelivery(receiptBytes, {
        senderPrivateKey: this.#receiverPrivateKey,
        receiverPublicKey: request.senderPublicKey,
        now: this.#safeNow(),
        relayUrl: replyRelayUrl,
        ...(this.#randomSecretKey === undefined ? {} : { randomSecretKey: this.#randomSecretKey }),
        ...(this.#randomNonce === undefined ? {} : { randomNonce: this.#randomNonce }),
        ...(this.#randomOffsetSeconds === undefined
          ? {}
          : { randomOffsetSeconds: this.#randomOffsetSeconds }),
      });
    } catch (error) {
      if (isTerminalProcessingError(error)) this.#processedEventIds.add(event.id);
      return;
    }
    const published = await Promise.allSettled(
      this.#relayUrls.map((relayUrl) => this.#publish(relayUrl, receipt)),
    );
    if (published.some((result) => result.status === 'fulfilled' && result.value.accepted)) {
      this.#processedEventIds.add(event.id);
    }
  }

  #safeNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Nostr receiver time is invalid');
    return now;
  }
}
