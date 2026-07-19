import { verifyEvent, type Event } from 'nostr-tools';
import WebSocket, { type RawData } from 'ws';
import type { GiftWrapFilter, GiftWrapSource } from './inbox.js';
import { normalizeRelayUrl } from './target.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAXIMUM_EVENTS = 10_000;
const MAXIMUM_MESSAGE_BYTES = 2_097_152;
let nextSubscription = 1;

export interface NostrRelayClientOptions {
  readonly relayUrl: string;
  readonly timeoutMs?: number;
  readonly maximumEvents?: number;
}

export interface RelayPublishResult {
  readonly accepted: boolean;
  readonly message: string;
}

function boundedInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum.toLocaleString('en-US')}`);
  }
  return value;
}

function tags(value: unknown): string[][] {
  if (
    !Array.isArray(value) ||
    value.some((tag) => !Array.isArray(tag) || tag.some((item) => typeof item !== 'string'))
  ) {
    throw new Error('Relay event tags are invalid');
  }
  return value.map((tag) => [...tag]);
}

function eventFrom(value: unknown): Event {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Relay event is invalid');
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
    throw new Error('Relay event fields are invalid');
  }
  const event: Event = {
    id: input.id,
    pubkey: input.pubkey,
    sig: input.sig,
    content: input.content,
    kind: input.kind,
    created_at: input.created_at,
    tags: tags(input.tags),
  };
  if (!verifyEvent(event)) throw new Error('Relay event signature is invalid');
  return event;
}

function parseMessage(data: RawData): readonly unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(data.toString()) as unknown;
  } catch {
    throw new Error('Relay returned invalid JSON');
  }
  if (!Array.isArray(value) || typeof value[0] !== 'string') {
    throw new Error('Relay returned an invalid message');
  }
  return value;
}

interface Operation<T> {
  readonly send: readonly unknown[];
  readonly receive: (
    message: readonly unknown[],
  ) => { readonly done: true; readonly value: T } | undefined;
}

function execute<T>(
  relayUrl: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: Operation<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(relayUrl, {
      maxPayload: MAXIMUM_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    let finished = false;
    const timeout = setTimeout(() => fail(new Error('Nostr relay operation timed out')), timeoutMs);
    const abort = (): void => fail(new Error('Nostr relay operation aborted'));
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    const succeed = (value: T): void => {
      if (finished) return;
      finished = true;
      cleanup();
      socket.close();
      resolve(value);
    };
    function fail(error: Error): void {
      if (finished) return;
      finished = true;
      cleanup();
      socket.terminate();
      reject(error);
    }
    if (signal?.aborted) {
      fail(new Error('Nostr relay operation aborted'));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('open', () => socket.send(JSON.stringify(operation.send)));
    socket.on('message', (data) => {
      try {
        const result = operation.receive(parseMessage(data));
        if (result?.done) succeed(result.value);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Nostr relay response is invalid'));
      }
    });
    socket.once('error', () => fail(new Error('Nostr relay connection failed')));
    socket.once('close', () => {
      if (!finished) fail(new Error('Nostr relay connection closed before completion'));
    });
  });
}

export class NostrRelayClient implements GiftWrapSource {
  readonly #relayUrl: string;
  readonly #timeoutMs: number;
  readonly #maximumEvents: number;

  constructor(options: NostrRelayClientOptions) {
    this.#relayUrl = normalizeRelayUrl(options.relayUrl);
    this.#timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'Relay timeout',
      300_000,
    );
    this.#maximumEvents = boundedInteger(
      options.maximumEvents ?? DEFAULT_MAXIMUM_EVENTS,
      'Relay query event limit',
      100_000,
    );
  }

  publish(event: Event, signal?: AbortSignal): Promise<RelayPublishResult> {
    return execute(this.#relayUrl, this.#timeoutMs, signal, {
      send: ['EVENT', event],
      receive: (message) => {
        if (message[0] !== 'OK' || message[1] !== event.id) return undefined;
        if (typeof message[2] !== 'boolean' || typeof message[3] !== 'string') {
          throw new Error('Relay OK message is invalid');
        }
        return { done: true, value: { accepted: message[2], message: message[3] } };
      },
    });
  }

  query(filter: GiftWrapFilter): Promise<readonly Event[]> {
    const subscriptionId = `cashu-fault-lab-${nextSubscription}`;
    nextSubscription += 1;
    const events = new Map<string, Event>();
    return execute(this.#relayUrl, this.#timeoutMs, undefined, {
      send: ['REQ', subscriptionId, filter],
      receive: (message) => {
        if (message[0] === 'EVENT' && message[1] === subscriptionId) {
          const event = eventFrom(message[2]);
          if (!events.has(event.id)) {
            if (events.size >= this.#maximumEvents)
              throw new Error('Relay query event limit exceeded');
            events.set(event.id, event);
          }
          return undefined;
        }
        if (message[0] === 'EOSE' && message[1] === subscriptionId) {
          return { done: true, value: [...events.values()] };
        }
        if (message[0] === 'CLOSED' && message[1] === subscriptionId) {
          throw new Error('Relay closed the history subscription');
        }
        return undefined;
      },
    });
  }
}
