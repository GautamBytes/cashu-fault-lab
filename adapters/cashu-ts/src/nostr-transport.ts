import {
  mergeObservedReceipt,
  parseDeliveryPayloadJson,
  parseDeliveryReceipt,
  serializeDeliveryReceipt,
  type DeliveryReceipt,
} from '@cashu-fault-lab/delivery-core';
import type { DeliveryReceiptView } from '@cashu-fault-lab/adapter-contract';
import {
  decodeNip17Target,
  NostrDeliveryInbox,
  NostrRelayClient,
  wrapDelivery,
  type GiftWrapSource,
  type RelayPublishResult,
  type WrapDeliveryOptions,
} from '@cashu-fault-lab/nostr-delivery';
import type { CashuTsTransportPort, CashuTsTransportTarget } from './funded-operations.js';

type WrappedEvent = ReturnType<typeof wrapDelivery>;

export type CashuTsNostrPublish = (
  relayUrl: string,
  event: WrappedEvent,
  signal: AbortSignal,
) => Promise<RelayPublishResult>;

export interface CashuTsNostrTransportOptions {
  readonly senderPrivateKey: Uint8Array;
  readonly now: () => number;
  readonly timeoutMs?: number;
  readonly pollAttempts?: number;
  readonly pollDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly publish?: CashuTsNostrPublish;
  readonly source?: (relayUrl: string) => GiftWrapSource;
  readonly randomSecretKey?: WrapDeliveryOptions['randomSecretKey'];
  readonly randomNonce?: WrapDeliveryOptions['randomNonce'];
  readonly randomOffsetSeconds?: WrapDeliveryOptions['randomOffsetSeconds'];
}

export interface CashuTsCompositeTransportOptions {
  readonly http: CashuTsTransportPort;
  readonly nostr?: CashuTsTransportPort;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function decodeJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Nostr receipt must be valid UTF-8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Nostr receipt must be valid JSON');
  }
}

export class CashuTsNostrTransport implements CashuTsTransportPort {
  readonly #senderPrivateKey: Uint8Array;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #pollAttempts: number;
  readonly #pollDelayMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #publish: CashuTsNostrPublish;
  readonly #source: (relayUrl: string) => GiftWrapSource;
  readonly #randomSecretKey: WrapDeliveryOptions['randomSecretKey'];
  readonly #randomNonce: WrapDeliveryOptions['randomNonce'];
  readonly #randomOffsetSeconds: WrapDeliveryOptions['randomOffsetSeconds'];

  constructor(options: CashuTsNostrTransportOptions) {
    if (
      !(options.senderPrivateKey instanceof Uint8Array) ||
      options.senderPrivateKey.length !== 32
    ) {
      throw new Error('Nostr sender private key must contain exactly 32 bytes');
    }
    this.#senderPrivateKey = Uint8Array.from(options.senderPrivateKey);
    this.#now = options.now;
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 'Nostr timeout', 1, 300_000);
    this.#pollAttempts = boundedInteger(options.pollAttempts ?? 3, 'Nostr poll attempts', 1, 100);
    this.#pollDelayMs = boundedInteger(options.pollDelayMs ?? 250, 'Nostr poll delay', 0, 60_000);
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#publish =
      options.publish ??
      ((relayUrl, event, signal) =>
        new NostrRelayClient({ relayUrl, timeoutMs: this.#timeoutMs }).publish(event, signal));
    this.#source =
      options.source ??
      ((relayUrl) => new NostrRelayClient({ relayUrl, timeoutMs: this.#timeoutMs }));
    this.#randomSecretKey = options.randomSecretKey;
    this.#randomNonce = options.randomNonce;
    this.#randomOffsetSeconds = options.randomOffsetSeconds;
  }

  async send(target: CashuTsTransportTarget, body: Uint8Array): Promise<DeliveryReceiptView> {
    if (target.type !== 'nostr') throw new Error('Nostr transport requires a Nostr target');
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Nostr sender time is invalid');
    const payload = parseDeliveryPayloadJson(body, now);
    const decoded = decodeNip17Target(target.target, target.tags);
    const event = wrapDelivery(body, {
      senderPrivateKey: this.#senderPrivateKey,
      receiverPublicKey: decoded.receiverPublicKey,
      now,
      relayUrl: decoded.relayUrls[0]!,
      ...(this.#randomSecretKey === undefined ? {} : { randomSecretKey: this.#randomSecretKey }),
      ...(this.#randomNonce === undefined ? {} : { randomNonce: this.#randomNonce }),
      ...(this.#randomOffsetSeconds === undefined
        ? {}
        : { randomOffsetSeconds: this.#randomOffsetSeconds }),
    });
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const publications = await Promise.allSettled(
      decoded.relayUrls.map((relayUrl) => this.#publish(relayUrl, event, signal)),
    );

    const inbox = new NostrDeliveryInbox({
      receiverPrivateKey: this.#senderPrivateKey,
      sources: decoded.relayUrls.map((relayUrl) => this.#source(relayUrl)),
    });
    let receipt: DeliveryReceipt | undefined;
    for (let attempt = 0; attempt < this.#pollAttempts; attempt += 1) {
      const replies = await inbox.backfill({ lastSeen: now });
      for (const reply of replies) {
        if (reply.senderPublicKey !== decoded.receiverPublicKey) continue;
        let candidate: DeliveryReceipt;
        try {
          candidate = parseDeliveryReceipt(decodeJson(reply.payloadBytes));
        } catch {
          continue;
        }
        if (candidate.deliveryId !== payload.delivery.id) continue;
        receipt = mergeObservedReceipt(receipt, candidate);
      }
      if (receipt !== undefined) return serializeDeliveryReceipt(receipt);
      if (attempt + 1 < this.#pollAttempts) await this.#sleep(this.#pollDelayMs);
    }

    const explicitRejections = publications.filter(
      (result): result is PromiseFulfilledResult<RelayPublishResult> =>
        result.status === 'fulfilled' && !result.value.accepted,
    );
    if (explicitRejections.length === publications.length) {
      throw new Error('Nostr relays rejected the payment event');
    }
    throw new Error('Nostr payment receipt was not observed');
  }
}

export class CashuTsCompositeTransport implements CashuTsTransportPort {
  readonly #http: CashuTsTransportPort;
  readonly #nostr: CashuTsTransportPort | undefined;

  constructor(options: CashuTsCompositeTransportOptions) {
    this.#http = options.http;
    this.#nostr = options.nostr;
  }

  send(target: CashuTsTransportTarget, body: Uint8Array): Promise<DeliveryReceiptView> {
    if (target.type === 'post') return this.#http.send(target, body);
    if (this.#nostr === undefined) {
      throw new Error('Cashu Nostr transport is not configured');
    }
    return this.#nostr.send(target, body);
  }
}
