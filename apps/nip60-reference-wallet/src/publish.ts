import type { Event } from 'nostr-tools';
import WebSocket, { type RawData } from 'ws';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAXIMUM_MESSAGE_BYTES = 2_097_152;

/**
 * Lab-only EVENT publisher for docker-compose service hostnames
 * (`ws://relay-a:4400`). Production delivery uses NostrRelayClient, which
 * requires WSS or loopback WS; the fixture deliberately lives on the compose
 * network and must reach sibling services by name.
 */
export async function publishLabEvent(
  relayUrl: string,
  event: Event,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    throw new Error(`fixture relay URL is invalid: ${relayUrl}`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`fixture relay URL must use ws or wss: ${relayUrl}`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error('fixture relay URL cannot contain credentials or a fragment');
  }

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url.href, {
      maxPayload: MAXIMUM_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    let finished = false;
    const timeout = setTimeout(
      () => fail(new Error(`fixture publish to ${url.href} timed out`)),
      timeoutMs,
    );
    const cleanup = (): void => clearTimeout(timeout);
    const succeed = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
      socket.close();
      resolve();
    };
    function fail(error: Error): void {
      if (finished) return;
      finished = true;
      cleanup();
      socket.terminate();
      reject(error);
    }
    socket.once('open', () => {
      socket.send(JSON.stringify(['EVENT', event]));
    });
    socket.on('message', (data: RawData) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString()) as unknown;
      } catch {
        fail(new Error(`fixture relay ${url.href} returned invalid JSON`));
        return;
      }
      if (!Array.isArray(message)) return;
      if (message[0] === 'OK' && message[1] === event.id) {
        if (message[2] === true) {
          succeed();
          return;
        }
        fail(
          new Error(
            `fixture relay ${url.href} rejected event ${event.id}: ${String(message[3] ?? '')}`,
          ),
        );
      }
    });
    socket.once('error', () => fail(new Error(`fixture relay ${url.href} connection failed`)));
    socket.once('close', () => {
      if (!finished) fail(new Error(`fixture relay ${url.href} closed before OK`));
    });
  });
}
