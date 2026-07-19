import { createServer, type Server } from 'node:http';
import { verifyEvent, type Event } from 'nostr-tools';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { NostrFaultControl, type NostrFaultEvidence, type NostrFaultRule } from './rules.js';

const DEFAULT_MAXIMUM_EVENTS = 100_000;
const DEFAULT_MAXIMUM_MESSAGE_BYTES = 2_097_152;
const MAXIMUM_FILTERS = 16;
const MAXIMUM_SUBSCRIPTIONS = 64;

type RelayFilter = Record<string, unknown>;

interface NostrFaultRelayOptions {
  readonly maximumEvents?: number;
  readonly maximumMessageBytes?: number;
}

function boundedInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum.toLocaleString('en-US')}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function numberArray(value: unknown): readonly number[] | undefined {
  return Array.isArray(value) && value.every((entry) => Number.isSafeInteger(entry) && entry >= 0)
    ? (value as number[])
    : undefined;
}

function prefixMatch(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function matchesFilter(event: Event, filter: RelayFilter): boolean {
  const ids = filter.ids === undefined ? undefined : stringArray(filter.ids);
  if (filter.ids !== undefined && (!ids || !prefixMatch(event.id, ids))) return false;
  const authors = filter.authors === undefined ? undefined : stringArray(filter.authors);
  if (filter.authors !== undefined && (!authors || !prefixMatch(event.pubkey, authors)))
    return false;
  const kinds = filter.kinds === undefined ? undefined : numberArray(filter.kinds);
  if (filter.kinds !== undefined && (!kinds || !kinds.includes(event.kind))) return false;
  if (
    filter.since !== undefined &&
    (!Number.isSafeInteger(filter.since) || event.created_at < (filter.since as number))
  ) {
    return false;
  }
  if (
    filter.until !== undefined &&
    (!Number.isSafeInteger(filter.until) || event.created_at > (filter.until as number))
  ) {
    return false;
  }
  for (const [name, value] of Object.entries(filter)) {
    if (!name.startsWith('#')) continue;
    const wanted = stringArray(value);
    if (!wanted) return false;
    const tagName = name.slice(1);
    if (!event.tags.some((tag) => tag[0] === tagName && tag[1] && wanted.includes(tag[1]))) {
      return false;
    }
  }
  return true;
}

function parseFilters(values: readonly unknown[]): readonly RelayFilter[] {
  if (values.length < 1 || values.length > MAXIMUM_FILTERS || !values.every(isRecord)) {
    throw new Error('Relay request filters are invalid');
  }
  return values;
}

function queryEvents(events: readonly Event[], filters: readonly RelayFilter[]): readonly Event[] {
  const selected = new Map<string, Event>();
  const newestFirst = [...events].sort(
    (left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id),
  );
  for (const filter of filters) {
    const requestedLimit = filter.limit;
    const limit =
      requestedLimit === undefined
        ? newestFirst.length
        : Number.isSafeInteger(requestedLimit) && (requestedLimit as number) >= 0
          ? Math.min(requestedLimit as number, newestFirst.length)
          : 0;
    for (const event of newestFirst
      .filter((candidate) => matchesFilter(candidate, filter))
      .slice(0, limit)) {
      selected.set(event.id, event);
    }
  }
  return [...selected.values()].sort(
    (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
  );
}

function send(socket: WebSocket, message: readonly unknown[]): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function includes(rules: readonly NostrFaultRule[], action: NostrFaultRule['action']): boolean {
  return rules.some((rule) => rule.action === action);
}

export class NostrFaultRelay {
  readonly control = new NostrFaultControl();
  readonly #maximumEvents: number;
  readonly #server: Server;
  readonly #webSockets: WebSocketServer;
  readonly #events = new Map<string, Event>();
  readonly #subscriptions = new Map<WebSocket, Map<string, readonly RelayFilter[]>>();

  constructor(options: NostrFaultRelayOptions = {}) {
    this.#maximumEvents = boundedInteger(
      options.maximumEvents ?? DEFAULT_MAXIMUM_EVENTS,
      'Relay event limit',
      1_000_000,
    );
    const maximumMessageBytes = boundedInteger(
      options.maximumMessageBytes ?? DEFAULT_MAXIMUM_MESSAGE_BYTES,
      'Relay message limit',
      10_485_760,
    );
    this.#server = createServer();
    this.#webSockets = new WebSocketServer({
      server: this.#server,
      maxPayload: maximumMessageBytes,
      perMessageDeflate: false,
    });
    this.#webSockets.on('connection', (socket) => {
      this.#subscriptions.set(socket, new Map());
      socket.on('close', () => this.#subscriptions.delete(socket));
      socket.on('message', (data) => {
        void this.#handle(socket, data).catch(() =>
          send(socket, ['NOTICE', 'invalid relay message']),
        );
      });
    });
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('Nostr relay did not bind TCP');
    return `ws://${host}:${address.port}`;
  }

  snapshot(): NostrFaultEvidence & { readonly storedEvents: number } {
    return { ...this.control.snapshot(), storedEvents: this.#events.size };
  }

  async close(): Promise<void> {
    for (const socket of this.#webSockets.clients) socket.terminate();
    if (this.#webSockets.clients.size > 0) await Promise.resolve();
    await new Promise<void>((resolve) => this.#webSockets.close(() => resolve()));
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async #handle(socket: WebSocket, data: RawData): Promise<void> {
    const value = JSON.parse(data.toString()) as unknown;
    if (!Array.isArray(value) || typeof value[0] !== 'string') {
      throw new Error('Relay message must be an array');
    }
    if (value[0] === 'EVENT') {
      this.#publish(socket, value[1]);
      return;
    }
    if (value[0] === 'REQ') {
      await this.#query(socket, value[1], value.slice(2));
      return;
    }
    if (value[0] === 'CLOSE') {
      this.#closeSubscription(socket, value[1]);
      return;
    }
    throw new Error('Relay message type is unsupported');
  }

  #publish(socket: WebSocket, value: unknown): void {
    if (!isRecord(value)) throw new Error('Relay event is invalid');
    const event: Event = {
      id: value.id as string,
      pubkey: value.pubkey as string,
      created_at: value.created_at as number,
      kind: value.kind as number,
      tags: value.tags as string[][],
      content: value.content as string,
      sig: value.sig as string,
    };
    if (!verifyEvent(event)) {
      send(socket, [
        'OK',
        typeof value.id === 'string' ? value.id : '',
        false,
        'invalid: signature',
      ]);
      return;
    }
    const rules = this.control.takePublish(event);
    if (!this.#events.has(event.id)) {
      if (this.#events.size >= this.#maximumEvents) {
        send(socket, ['OK', event.id, false, 'error: relay event limit exceeded']);
        return;
      }
      this.#events.set(event.id, event);
    }
    const duplicateRule = rules.find((rule) => rule.action === 'duplicate_publish');
    const copies = 1 + (duplicateRule?.duplicateCount ?? 0);
    for (const [subscriber, subscriptions] of this.#subscriptions) {
      for (const [subscriptionId, filters] of subscriptions) {
        if (!filters.some((filter) => matchesFilter(event, filter))) continue;
        for (let copy = 0; copy < copies; copy += 1) {
          send(subscriber, ['EVENT', subscriptionId, event]);
        }
      }
    }
    if (includes(rules, 'disconnect')) {
      socket.terminate();
      return;
    }
    if (!includes(rules, 'drop_ok')) send(socket, ['OK', event.id, true, '']);
  }

  async #query(
    socket: WebSocket,
    subscriptionValue: unknown,
    filterValues: unknown[],
  ): Promise<void> {
    if (
      typeof subscriptionValue !== 'string' ||
      subscriptionValue.length < 1 ||
      subscriptionValue.length > 64
    ) {
      throw new Error('Relay subscription id is invalid');
    }
    const filters = parseFilters(filterValues);
    const subscriptions = this.#subscriptions.get(socket);
    if (!subscriptions) return;
    if (!subscriptions.has(subscriptionValue) && subscriptions.size >= MAXIMUM_SUBSCRIPTIONS) {
      throw new Error('Relay subscription limit exceeded');
    }
    subscriptions.set(subscriptionValue, filters);
    const rules = this.control.takeHistory();
    const delayRule = rules.find((rule) => rule.action === 'delay_history');
    if (delayRule) await pause(delayRule.delayMs ?? 0);
    let history = [...queryEvents([...this.#events.values()], filters)];
    if (includes(rules, 'reorder_history')) history = history.reverse();
    for (const event of history) send(socket, ['EVENT', subscriptionValue, event]);
    send(socket, ['EOSE', subscriptionValue]);
  }

  #closeSubscription(socket: WebSocket, subscriptionValue: unknown): void {
    if (typeof subscriptionValue !== 'string') throw new Error('Relay subscription id is invalid');
    this.#subscriptions.get(socket)?.delete(subscriptionValue);
  }
}
