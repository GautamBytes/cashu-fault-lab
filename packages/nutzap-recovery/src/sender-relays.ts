import { verifyEvent, type Event, type Filter } from 'nostr-tools';
import type { Journal } from './journal.js';

/** Discover on configured relays; metadata never authorizes a public network connection. */
export async function discoverSenderRelays(
  db: Journal,
  sender: string,
  sources: string[],
  query: (relay: string, filter: Filter) => Promise<Event[]>,
): Promise<string[]> {
  const answers = await Promise.allSettled(
    sources.map((r) => query(r, { kinds: [10002], authors: [sender] })),
  );
  for (const answer of answers) {
    if (answer.status !== 'fulfilled') continue;
    if (answer.value.length > 128) throw Error('Too many relay lists');
    for (const raw of answer.value) {
      let event: Event;
      try {
        if (Buffer.byteLength(JSON.stringify(raw)) > 65536) continue;
        // Avoid nostr-tools' cached signature-verification symbol on mutable objects.
        event = JSON.parse(JSON.stringify(raw));
        if (
          event.kind !== 10002 ||
          event.pubkey !== sender ||
          !Number.isSafeInteger(event.created_at) ||
          event.created_at < 0 ||
          event.created_at > Math.floor(Date.now() / 1000) + 300 ||
          !verifyEvent(event)
        )
          continue;
      } catch {
        continue;
      }
      db.rememberRelayList(event);
    }
  }
  const event = db.relayList(sender);
  if (!event) {
    if (answers.some((a) => a.status === 'rejected'))
      throw Error('Sender relay discovery unavailable');
    return [];
  }
  const relays = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== 'r' || (tag.length !== 2 && !(tag.length === 3 && tag[2] === 'read'))) continue;
    const url = new URL(tag[1]!);
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.hash
    )
      throw Error('Sender relay must be a local test relay');
    relays.add(url.href);
    if (relays.size > 4) throw Error('Too many sender read relays');
  }
  return [...relays];
}
