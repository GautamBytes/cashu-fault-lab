import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { expect, it } from 'vitest';
import { queryEvents } from '../src/relay.js';

const key = Uint8Array.from([...Array(31).fill(0), 1]);
const event = finalizeEvent(
  {
    kind: 9321,
    created_at: 10,
    content: '',
    tags: [
      ['p', getPublicKey(key)],
      ['u', 'http://127.0.0.1:3338'],
    ],
  },
  key,
);

it.each([
  { kinds: [7375] },
  { authors: ['ab'.repeat(32)] },
  { '#p': ['ab'.repeat(32)] },
  { '#u': ['http://127.0.0.1:9999'] },
  { since: 11 },
])('rejects signed relay events outside the requested filter: %j', async (filter) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected local relay port');
  server.on('connection', (socket) =>
    socket.on('message', () => {
      socket.send(JSON.stringify(['EVENT', 'nutzap-suite', event]));
      socket.send(JSON.stringify(['EOSE', 'nutzap-suite']));
    }),
  );
  try {
    await expect(queryEvents(`ws://127.0.0.1:${address.port}`, filter)).rejects.toThrow();
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
