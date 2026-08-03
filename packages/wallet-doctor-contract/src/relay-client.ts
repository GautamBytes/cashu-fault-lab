import { verifyEvent, type Event } from 'nostr-tools';
import WebSocket, { type RawData } from 'ws';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAXIMUM_EVENTS = 50_000;
const MAXIMUM_MESSAGE_BYTES = 2_097_152;
let nextSubscription = 1;

/**
 * Fetch every NIP-60-relevant event authored by the subject from one relay.
 * Read-only: one REQ, collected until EOSE. Signatures are verified here;
 * events failing verification are dropped and counted by the caller.
 */
export function fetchNip60Events(
  relayUrl: string,
  subject: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<readonly Event[]> {
  const subscriptionId = `nip60-doctor-${nextSubscription}`;
  nextSubscription += 1;
  const filter = { kinds: [17375, 7375, 7376, 7374, 5], authors: [subject] };
  const events = new Map<string, Event>();

  return new Promise<readonly Event[]>((resolve, reject) => {
    const socket = new WebSocket(relayUrl, {
      maxPayload: MAXIMUM_MESSAGE_BYTES,
      perMessageDeflate: false,
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
    socket.once('open', () => {
      socket.send(JSON.stringify(['REQ', subscriptionId, filter]));
    });
    socket.on('message', (data: RawData) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString()) as unknown;
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
          verifyEvent(event)
        ) {
          if (!events.has(event.id)) {
            if (events.size >= MAXIMUM_EVENTS) {
              fail(new Error(`relay ${relayUrl} exceeded the query event limit`));
              return;
            }
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
