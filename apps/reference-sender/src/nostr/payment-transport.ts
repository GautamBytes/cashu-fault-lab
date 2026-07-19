import {
  mergeObservedReceipt,
  parseDeliveryPayloadJson,
  parseDeliveryReceipt,
  serializeDeliveryReceipt,
  type DeliveryReceipt,
} from '@cashu-fault-lab/delivery-core';
import {
  decodeNip17Target,
  NostrDeliveryInbox,
  NostrRelayClient,
  wrapDelivery,
  type GiftWrapSource,
  type RelayPublishResult,
  type WrapDeliveryOptions,
} from '@cashu-fault-lab/nostr-delivery';
import type { PaymentTransport, TransportResult, TransportTarget } from '../ports/transport.js';

type WrappedEvent = ReturnType<typeof wrapDelivery>;

export type NostrPublish = (
  relayUrl: string,
  event: WrappedEvent,
  signal: AbortSignal,
) => Promise<RelayPublishResult>;

export interface NostrPaymentTransportOptions {
  readonly senderPrivateKey: Uint8Array;
  readonly now: () => number;
  readonly timeoutMs?: number;
  readonly pollAttempts?: number;
  readonly pollDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly publish?: NostrPublish;
  readonly source?: (relayUrl: string) => GiftWrapSource;
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

export class NostrPaymentTransport implements PaymentTransport {
  readonly #senderPrivateKey: Uint8Array;
  readonly #now: () => number;
  readonly #pollAttempts: number;
  readonly #pollDelayMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #publish: NostrPublish;
  readonly #source: (relayUrl: string) => GiftWrapSource;
  readonly #randomSecretKey: WrapDeliveryOptions['randomSecretKey'];
  readonly #randomNonce: WrapDeliveryOptions['randomNonce'];
  readonly #randomOffsetSeconds: WrapDeliveryOptions['randomOffsetSeconds'];

  constructor(options: NostrPaymentTransportOptions) {
    this.#senderPrivateKey = Uint8Array.from(options.senderPrivateKey);
    this.#now = options.now;
    const timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 'Nostr timeout', 1, 300_000);
    this.#pollAttempts = boundedInteger(options.pollAttempts ?? 3, 'Nostr poll attempts', 1, 20);
    this.#pollDelayMs = boundedInteger(options.pollDelayMs ?? 250, 'Nostr poll delay', 0, 60_000);
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#publish =
      options.publish ??
      ((relayUrl, event, signal) =>
        new NostrRelayClient({ relayUrl, timeoutMs }).publish(event, signal));
    this.#source = options.source ?? ((relayUrl) => new NostrRelayClient({ relayUrl, timeoutMs }));
    this.#randomSecretKey = options.randomSecretKey;
    this.#randomNonce = options.randomNonce;
    this.#randomOffsetSeconds = options.randomOffsetSeconds;
  }

  async send(
    payloadBytes: Uint8Array,
    transportTarget: TransportTarget,
    signal: AbortSignal,
  ): Promise<TransportResult> {
    if (transportTarget.type !== 'nostr')
      throw new Error('Nostr transport requires a Nostr target');
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Nostr sender time is invalid');
    const payload = parseDeliveryPayloadJson(payloadBytes, now);
    const target = decodeNip17Target(transportTarget.target, transportTarget.tags);
    const event = wrapDelivery(payloadBytes, {
      senderPrivateKey: this.#senderPrivateKey,
      receiverPublicKey: target.receiverPublicKey,
      now,
      relayUrl: target.relayUrls[0]!,
      ...(this.#randomSecretKey === undefined ? {} : { randomSecretKey: this.#randomSecretKey }),
      ...(this.#randomNonce === undefined ? {} : { randomNonce: this.#randomNonce }),
      ...(this.#randomOffsetSeconds === undefined
        ? {}
        : { randomOffsetSeconds: this.#randomOffsetSeconds }),
    });
    const publications = await Promise.allSettled(
      target.relayUrls.map((relayUrl) => this.#publish(relayUrl, event, signal)),
    );

    const inbox = new NostrDeliveryInbox({
      receiverPrivateKey: this.#senderPrivateKey,
      sources: target.relayUrls.map(this.#source),
    });
    let receipt: DeliveryReceipt | undefined;
    for (let attempt = 0; attempt < this.#pollAttempts; attempt += 1) {
      if (signal.aborted) throw new Error('Nostr payment was aborted');
      const replies = await inbox.backfill({ lastSeen: now });
      for (const reply of replies) {
        if (reply.senderPublicKey !== target.receiverPublicKey) continue;
        let candidate: DeliveryReceipt;
        try {
          candidate = parseDeliveryReceipt(decodeJson(reply.payloadBytes));
        } catch {
          continue;
        }
        if (candidate.deliveryId !== payload.delivery.id) continue;
        receipt = mergeObservedReceipt(receipt, candidate);
      }
      if (receipt) return { kind: 'receipt', receipt: serializeDeliveryReceipt(receipt) };
      if (attempt + 1 < this.#pollAttempts) await this.#sleep(this.#pollDelayMs);
    }

    const explicitRejections = publications.filter(
      (result): result is PromiseFulfilledResult<RelayPublishResult> =>
        result.status === 'fulfilled' && !result.value.accepted,
    );
    if (explicitRejections.length === publications.length) {
      return { kind: 'permanent_failure', status: 422, code: 'NOSTR_RELAY_REJECTED' };
    }
    return { kind: 'no_response' };
  }
}
