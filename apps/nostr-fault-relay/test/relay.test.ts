import { once } from 'node:events';
import { getPublicKey, type Event } from 'nostr-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { NostrRelayClient, wrapDelivery } from '../../../packages/nostr-delivery/src/index.js';
import { NostrFaultRelay } from '../src/index.js';

const senderKey = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const receiverKey = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const receiverPublicKey = getPublicKey(receiverKey);

function wrappedEvent(wrapperByte: string, now: number): Event {
  return wrapDelivery(new TextEncoder().encode(`{"delivery":{"created_at":${now}}}`), {
    senderPrivateKey: senderKey,
    receiverPublicKey,
    now,
    randomSecretKey: () => Uint8Array.from(Buffer.from(wrapperByte.repeat(32), 'hex')),
    randomOffsetSeconds: () => 1,
  });
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  return socket;
}

function messages(socket: WebSocket): unknown[][] {
  const received: unknown[][] = [];
  socket.on('message', (data) => received.push(JSON.parse(data.toString()) as unknown[]));
  return received;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe('NostrFaultRelay', () => {
  let relay: NostrFaultRelay;
  let url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    relay = new NostrFaultRelay();
    url = await relay.listen();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await relay.close();
  });

  async function socket(): Promise<WebSocket> {
    const result = await connect(url);
    sockets.push(result);
    return result;
  }

  it('drops relay OK after commit and exposes the event through reconnect/backfill', async () => {
    relay.control.setRule({ action: 'drop_ok', count: 1 });
    const event = wrappedEvent('33', 2_000_000);
    const publisher = await socket();
    const publisherMessages = messages(publisher);

    publisher.send(JSON.stringify(['EVENT', event]));
    await settle();

    expect(publisherMessages).toEqual([]);
    const reader = await socket();
    const readerMessages = messages(reader);
    reader.send(JSON.stringify(['REQ', 'backfill', { kinds: [1059], '#p': [receiverPublicKey] }]));
    await settle();
    expect(readerMessages.map((message) => [message[0], message[1]])).toEqual([
      ['EVENT', 'backfill'],
      ['EOSE', 'backfill'],
    ]);
    expect((readerMessages[0]?.[2] as Event).id).toBe(event.id);
    expect(relay.snapshot().storedEvents).toBe(1);
  });

  it('duplicates subscriber delivery without duplicating durable storage', async () => {
    relay.control.setRule({ action: 'duplicate_publish', count: 1, duplicateCount: 2 });
    const reader = await socket();
    const readerMessages = messages(reader);
    reader.send(JSON.stringify(['REQ', 'live', { kinds: [1059] }]));
    await settle();
    readerMessages.length = 0;

    const publisher = await socket();
    publisher.send(JSON.stringify(['EVENT', wrappedEvent('44', 2_000_001)]));
    await settle();

    expect(readerMessages.filter(([type]) => type === 'EVENT')).toHaveLength(3);
    expect(relay.snapshot().storedEvents).toBe(1);
  });

  it('delays and reverses history deterministically', async () => {
    const publisher = await socket();
    const first = wrappedEvent('55', 2_000_002);
    const second = wrappedEvent('66', 2_000_003);
    publisher.send(JSON.stringify(['EVENT', first]));
    publisher.send(JSON.stringify(['EVENT', second]));
    await settle();
    relay.control.setRule({ action: 'delay_history', count: 1, delayMs: 20 });
    relay.control.setRule({ action: 'reorder_history', count: 1 });

    const reader = await socket();
    const readerMessages = messages(reader);
    const started = Date.now();
    reader.send(JSON.stringify(['REQ', 'history', { kinds: [1059] }]));
    await settle();

    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(
      readerMessages
        .filter(([type]) => type === 'EVENT')
        .map((message) => (message[2] as Event).id),
    ).toEqual([second.id, first.id]);
  });

  it('disconnects after storing and permits recovery from a new connection', async () => {
    relay.control.setRule({ action: 'disconnect', count: 1 });
    const event = wrappedEvent('77', 2_000_004);
    const publisher = await socket();
    const closed = once(publisher, 'close');
    publisher.send(JSON.stringify(['EVENT', event]));
    await closed;

    const reader = await socket();
    const readerMessages = messages(reader);
    reader.send(JSON.stringify(['REQ', 'recover', { ids: [event.id] }]));
    await settle();
    expect(readerMessages.map((message) => [message[0], message[1]])).toEqual([
      ['EVENT', 'recover'],
      ['EOSE', 'recover'],
    ]);
    expect((readerMessages[0]?.[2] as Event).id).toBe(event.id);
  });

  it('interoperates with the bounded delivery relay client', async () => {
    const event = wrappedEvent('88', 2_000_005);
    const client = new NostrRelayClient({ relayUrl: url, timeoutMs: 1_000 });

    await expect(client.publish(event)).resolves.toEqual({ accepted: true, message: '' });
    await expect(
      client.query({ kinds: [1059], '#p': [receiverPublicKey], since: 2_000_000 }),
    ).resolves.toMatchObject([{ id: event.id }]);
  });
});
