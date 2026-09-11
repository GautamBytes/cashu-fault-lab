import WebSocket from 'ws';
import { matchFilter, verifyEvent, type Event, type Filter } from 'nostr-tools';

async function exchange(
  url: string,
  request: unknown[],
  read: (message: unknown[]) => boolean,
): Promise<void> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'ws:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username ||
    parsed.password
  )
    throw Error('Nutzap suite requires a local relay');
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { maxPayload: 262144, perMessageDeflate: false });
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.terminate();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(Error('Nutzap relay timeout')), 1500);
    socket.once('open', () => socket.send(JSON.stringify(request)));
    socket.on('message', (raw) => {
      try {
        const message: unknown = JSON.parse(raw.toString());
        if (!Array.isArray(message)) throw Error('Invalid relay response');
        if (read(message)) finish();
      } catch {
        finish(Error('Invalid nutzap relay response'));
      }
    });
    socket.once('error', () => finish(Error('Nutzap relay transport failed')));
    socket.once('close', () => {
      if (!done) finish(Error('Nutzap relay closed early'));
    });
  });
}
export async function publishEvent(url: string, event: Event): Promise<void> {
  await exchange(url, ['EVENT', event], (message) => {
    if (message[0] !== 'OK' || message[1] !== event.id) return false;
    if (message[2] !== true) throw Error('Event rejected');
    return true;
  });
}
export async function queryEvents(url: string, filter: Filter): Promise<Event[]> {
  const events: Event[] = [];
  await exchange(url, ['REQ', 'nutzap-suite', { ...filter, limit: 128 }], (m) => {
    if (m[1] !== 'nutzap-suite') return false;
    if (m[0] === 'EVENT') {
      const event = m[2] as Event;
      if (events.length >= 128 || !verifyEvent(event) || !matchFilter(filter, event))
        throw Error('Invalid relay event');
      events.push(event);
    }
    return m[0] === 'EOSE';
  });
  return events;
}
