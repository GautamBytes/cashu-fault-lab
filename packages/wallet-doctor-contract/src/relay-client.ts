import { verifyEvent, type Event } from 'nostr-tools';
import WebSocket, { type RawData } from 'ws';
import { assertSafeRelayUrl, createPinnedLookup, type HostResolver } from './network-policy.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAXIMUM_EVENTS = 10_000;
const MAXIMUM_MESSAGE_BYTES = 2_097_152;
const MAXIMUM_CONTENT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_WIRE_BYTES = 32 * 1024 * 1024;
const NIP60_RELEVANT_KINDS: ReadonlySet<number> = new Set([17375, 7375, 7376, 7374, 5]);
const RELAY_LIST_KINDS: ReadonlySet<number> = new Set([10019, 10002]);
let nextSubscription = 1;

interface RelayFetchOptions {
  readonly allowInsecureLoopback?: boolean;
  readonly resolver?: HostResolver;
  /** Caller-level remaining budgets; hard transport ceilings still apply. */
  readonly maxEvents?: number;
  readonly maxContentBytes?: number;
  readonly maxWireBytes?: number;
}

/** Reject relay responses that ignore the REQ author/kind filter. */
export function isNip60EventForSubject(event: Event, subject: string): boolean {
  return event.pubkey === subject && NIP60_RELEVANT_KINDS.has(event.kind) && verifyEvent(event);
}

function validRelayUrl(value: string, allowInsecureLoopback = false): boolean {
  try {
    assertSafeRelayUrl(value, allowInsecureLoopback);
    return true;
  } catch {
    return false;
  }
}

function latestEvent(events: readonly Event[], kind: number): Event | undefined {
  return events
    .filter((event) => event.kind === kind)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

/** Apply NIP-60 kind 10019 discovery with the specified NIP-65 fallback. */
export function selectNip60Relays(
  events: readonly Event[],
  options: { readonly allowInsecureLoopback?: boolean } = {},
): readonly string[] {
  const allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  const walletList = latestEvent(events, 10019);
  const walletRelays = (walletList?.tags ?? [])
    .filter(
      (tag) =>
        tag[0] === 'relay' &&
        typeof tag[1] === 'string' &&
        validRelayUrl(tag[1], allowInsecureLoopback),
    )
    .map((tag) => tag[1] as string);
  if (walletRelays.length > 0) return [...new Set(walletRelays)].sort();

  const nip65 = latestEvent(events, 10002);
  const fallback = (nip65?.tags ?? [])
    .filter(
      (tag) =>
        tag[0] === 'r' &&
        typeof tag[1] === 'string' &&
        (tag[2] === undefined || tag[2] === 'write') &&
        validRelayUrl(tag[1], allowInsecureLoopback),
    )
    .map((tag) => tag[1] as string);
  return [...new Set(fallback)].sort();
}

function fetchSubjectEvents(
  relayUrl: string,
  subject: string,
  kinds: ReadonlySet<number>,
  timeoutMs: number,
  options: RelayFetchOptions = {},
): Promise<readonly Event[]> {
  const allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  assertSafeRelayUrl(relayUrl, allowInsecureLoopback);
  const subscriptionId = `nip60-doctor-${nextSubscription}`;
  nextSubscription += 1;
  const filter = { kinds: [...kinds], authors: [subject] };
  const events = new Map<string, Event>();
  const maximumEvents = Math.max(0, Math.min(options.maxEvents ?? MAXIMUM_EVENTS, MAXIMUM_EVENTS));
  const maximumContentBytes = Math.max(
    0,
    Math.min(options.maxContentBytes ?? MAXIMUM_CONTENT_BYTES, MAXIMUM_CONTENT_BYTES),
  );
  const maximumWireBytes = Math.max(
    0,
    Math.min(options.maxWireBytes ?? MAXIMUM_WIRE_BYTES, MAXIMUM_WIRE_BYTES),
  );
  let contentBytes = 0;
  let wireBytes = 0;

  return new Promise<readonly Event[]>((resolve, reject) => {
    const socket = new WebSocket(relayUrl, {
      maxPayload: MAXIMUM_MESSAGE_BYTES,
      perMessageDeflate: false,
      lookup: createPinnedLookup(allowInsecureLoopback, options.resolver),
    });
    let finished = false;
    const timeout = setTimeout(
      () => fail(new Error(`relay ${relayUrl} query timed out`)),
      timeoutMs,
    );
    const cleanup = (): void => clearTimeout(timeout);
    const succeed = (value: readonly Event[]): void => {
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
    socket.once('open', () => socket.send(JSON.stringify(['REQ', subscriptionId, filter])));
    socket.on('message', (data: RawData) => {
      const raw = data.toString();
      wireBytes += Buffer.byteLength(raw, 'utf8');
      if (wireBytes > maximumWireBytes) {
        fail(new Error(`relay ${relayUrl} exceeded the query wire-byte limit`));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(raw) as unknown;
      } catch {
        fail(new Error(`relay ${relayUrl} returned invalid JSON`));
        return;
      }
      if (!Array.isArray(message)) return;
      if (message[0] === 'EVENT' && message[1] === subscriptionId) {
        const event = message[2] as Event;
        if (
          typeof event?.id === 'string' &&
          typeof event?.sig === 'string' &&
          typeof event?.content === 'string' &&
          typeof event?.created_at === 'number' &&
          typeof event?.kind === 'number' &&
          event.pubkey === subject &&
          kinds.has(event.kind) &&
          verifyEvent(event)
        ) {
          if (!events.has(event.id)) {
            if (events.size >= maximumEvents) {
              fail(new Error(`relay ${relayUrl} exceeded the query event limit`));
              return;
            }
            const eventContentBytes = Buffer.byteLength(event.content, 'utf8');
            if (contentBytes > maximumContentBytes - eventContentBytes) {
              fail(new Error(`relay ${relayUrl} exceeded the query content-byte limit`));
              return;
            }
            contentBytes += eventContentBytes;
            events.set(event.id, event);
          }
        }
        return;
      }
      if (message[0] === 'EOSE' && message[1] === subscriptionId) {
        succeed([...events.values()]);
        return;
      }
      if (message[0] === 'CLOSED' && message[1] === subscriptionId) {
        fail(new Error(`relay ${relayUrl} closed the subscription`));
        return;
      }
      if (message[0] === 'NOTICE') {
        fail(new Error(`relay ${relayUrl} NOTICE: ${String(message[1])}`));
      }
    });
    socket.once('error', () => fail(new Error(`relay ${relayUrl} connection failed`)));
    socket.once('close', () => {
      if (!finished) fail(new Error(`relay ${relayUrl} closed before EOSE`));
    });
  });
}

/** Discover NIP-60 wallet relays from operator-provided bootstrap relays. */
export async function discoverNip60Relays(
  subject: string,
  bootstrapRelays: readonly string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options: RelayFetchOptions & { readonly overallTimeoutMs?: number } = {},
): Promise<readonly string[]> {
  if (
    bootstrapRelays.length === 0 ||
    bootstrapRelays.length > 64 ||
    new Set(bootstrapRelays).size !== bootstrapRelays.length
  ) {
    throw new Error('relay discovery requires 1-64 unique bootstrap relay URLs');
  }
  const overallTimeoutMs = options.overallTimeoutMs ?? timeoutMs;
  if (
    !Number.isSafeInteger(overallTimeoutMs) ||
    overallTimeoutMs < 100 ||
    overallTimeoutMs > 600_000
  ) {
    throw new Error(
      'relay discovery overall timeout must be an integer from 100 to 600000 milliseconds',
    );
  }
  const deadline = Date.now() + overallTimeoutMs;
  const events: Event[] = [];
  let contentBytes = 0;
  let successful = 0;
  for (const relay of bootstrapRelays) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('relay discovery exceeded its overall timeout');
    try {
      const fetched = await fetchSubjectEvents(
        relay,
        subject,
        RELAY_LIST_KINDS,
        Math.min(timeoutMs, remaining),
        {
          ...options,
          maxEvents: Math.min(options.maxEvents ?? 1024, 1024 - events.length),
          maxContentBytes: Math.min(
            options.maxContentBytes ?? 2 * 1024 * 1024,
            2 * 1024 * 1024 - contentBytes,
          ),
          maxWireBytes: Math.min(options.maxWireBytes ?? 4 * 1024 * 1024, 4 * 1024 * 1024),
        },
      );
      events.push(...fetched);
      contentBytes += fetched.reduce(
        (total, event) => total + Buffer.byteLength(event.content, 'utf8'),
        0,
      );
      successful += 1;
    } catch {
      // A bootstrap relay is a hint. Other bootstrap relays may still answer.
      if (Date.now() >= deadline) throw new Error('relay discovery exceeded its overall timeout');
    }
  }
  if (successful === 0) throw new Error('relay discovery failed on every bootstrap relay');
  const selected = selectNip60Relays(events, options);
  if (selected.length === 0) {
    throw new Error('no kind 10019 or NIP-65 write relays were discovered for the subject');
  }
  return selected;
}

/**
 * Fetch every NIP-60-relevant event authored by the subject from one relay.
 * Read-only: one REQ, collected until EOSE. Signatures are verified here;
 * events failing verification are dropped and counted by the caller.
 */
export function fetchNip60Events(
  relayUrl: string,
  subject: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options: RelayFetchOptions = {},
): Promise<readonly Event[]> {
  return fetchSubjectEvents(relayUrl, subject, NIP60_RELEVANT_KINDS, timeoutMs, options);
}
