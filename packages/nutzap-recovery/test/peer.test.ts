import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey, nip44, type Event } from 'nostr-tools';
import { receiveNutzap } from '../src/receiver.js';
import { Journal } from '../src/journal.js';
import { SimulatedMint } from '../src/simulated-mint.js';

const key = Uint8Array.from([...Array(31).fill(0), 1]);
const lock = Uint8Array.from([...Array(31).fill(0), 2]);
const mintUrl = 'http://127.0.0.1:3338';
const relays = ['ws://127.0.0.1:4400', 'ws://127.0.0.1:4401'];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nutzap-peer-'));
  dirs.push(directory);
  const mint = new SimulatedMint(getPublicKey(lock), 'peer-test');
  const info = finalizeEvent(
    {
      kind: 10019,
      created_at: 1,
      content: '',
      tags: [
        ['pubkey', getPublicKey(lock)],
        ['mint', mintUrl, 'sat'],
      ],
    },
    key,
  );
  const event = finalizeEvent(
    {
      kind: 9321,
      created_at: 2,
      content: '',
      tags: [
        ['p', getPublicKey(key)],
        ['u', mintUrl],
        ...mint.source().map((p) => ['proof', JSON.stringify(p)]),
      ],
    },
    lock,
  );
  const published = new Map<string, Event>();
  const common = {
    key,
    info,
    relays,
    mint,
    publish: async (_: string, event: Event) => {
      published.set(event.id, event);
    },
  };
  const winner = { ...common, database: join(directory, 'winner.sqlite') };
  const loser = {
    ...common,
    database: join(directory, 'loser.sqlite'),
    query: async () => [...published.values()],
  };
  return { winner, loser, event, published, mint };
}
function summary(path: string) {
  const db = new Journal(path);
  try {
    return db.summary();
  } finally {
    db.close();
  }
}
function rewrite(
  events: Event[],
  change: (token: Record<string, any>, history: string[][]) => void,
): Event[] {
  const conversation = nip44.v2.utils.getConversationKey(key, getPublicKey(key));
  const token = events.find((e) => e.kind === 7375)!;
  const history = events.find((e) => e.kind === 7376)!;
  const body = JSON.parse(nip44.v2.decrypt(token.content, conversation));
  const tags = JSON.parse(nip44.v2.decrypt(history.content, conversation));
  change(body, tags);
  const newToken = finalizeEvent(
    { ...token, content: nip44.v2.encrypt(JSON.stringify(body), conversation) },
    key,
  );
  const newHistory = finalizeEvent(
    {
      ...history,
      content: nip44.v2.encrypt(
        JSON.stringify(
          tags.map((t: string[]) =>
            t[0] === 'e' && t[3] === 'created' ? [...t.slice(0, 1), newToken.id, ...t.slice(2)] : t,
          ),
        ),
        conversation,
      ),
    },
    key,
  );
  return [newToken, newHistory];
}
it('adopts the winner through relays without a second economic credit and survives restart', async () => {
  const f = await fixture();
  expect(await receiveNutzap(f.event, f.winner)).toBe('complete');
  expect(await receiveNutzap(f.event, f.loser)).toBe('complete');
  expect(await receiveNutzap(f.event, f.loser)).toBe('complete');
  expect(summary(f.winner.database)).toEqual({ credits: 1, balance: 15 });
  expect(summary(f.loser.database)).toEqual({ credits: 0, balance: 15 });
  expect(f.mint.successfulSwaps).toBe(1);
  expect(f.published.size).toBe(2);
});
it('does not infer successful peer redemption from spent inputs without complete relay evidence', async () => {
  const f = await fixture();
  await receiveNutzap(f.event, f.winner);
  f.loser.query = async () => [...f.published.values()].filter((e) => e.kind === 7376);
  expect(await receiveNutzap(f.event, f.loser)).toBe('awaiting-peer');
  expect(summary(f.loser.database)).toEqual({ credits: 0, balance: 0 });
});
it.each([
  'amount',
  'direction',
  'unit',
  'mint',
  'proofs',
  'signature',
  'author',
  'conflict',
  'spent-output',
  'invalid-proof',
])('rejects invalid peer evidence: %s', async (fault) => {
  const f = await fixture();
  await receiveNutzap(f.event, f.winner);
  let events = [...f.published.values()];
  if (['amount', 'direction', 'unit', 'mint', 'proofs'].includes(fault))
    events = rewrite(events, (token, history) => {
      if (fault === 'mint') token.mint = 'http://127.0.0.1:9999';
      else if (fault === 'proofs') token.proofs = [...token.proofs, ...token.proofs];
      else {
        const tag = history.find((t) => t[0] === fault)!;
        tag[1] = fault === 'amount' ? '999' : fault === 'direction' ? 'out' : 'usd';
      }
    });
  if (fault === 'signature') events = events.map((e) => ({ ...e, content: 'tampered' }));
  if (fault === 'author') events = events.map((e) => finalizeEvent(e, lock));
  if (fault === 'conflict') events.push(...rewrite(events, () => {}));
  if (fault === 'spent-output') f.mint.states = async (proofs) => proofs.map(() => 'SPENT');
  if (fault === 'invalid-proof')
    events = rewrite(events, (token) => {
      token.proofs[0].C = '02' + '00'.repeat(32);
    });
  f.loser.query = async () => events;
  expect(await receiveNutzap(f.event, f.loser)).toBe('awaiting-peer');
  expect(summary(f.loser.database)).toEqual({ credits: 0, balance: 0 });
});
it('recovers after a relay outage ends', async () => {
  const f = await fixture();
  await receiveNutzap(f.event, f.winner);
  const query = f.loser.query;
  f.loser.query = async () => {
    throw Error('offline');
  };
  expect(await receiveNutzap(f.event, f.loser)).toBe('awaiting-peer');
  f.loser.query = query;
  expect(await receiveNutzap(f.event, f.loser)).toBe('complete');
  expect(summary(f.loser.database)).toEqual({ credits: 0, balance: 15 });
});

it('does not add the same output proofs twice under different nutzap receipts', async () => {
  const f = await fixture();
  await receiveNutzap(f.event, f.winner);
  expect(await receiveNutzap(f.event, f.loser)).toBe('complete');
  const replacement = {
    ...f.mint.source()[0]!,
    secret: JSON.stringify(['P2PK', { nonce: 'second-input', data: `02${getPublicKey(lock)}` }]),
  };
  const second = finalizeEvent(
    {
      ...f.event,
      created_at: 3,
      tags: f.event.tags.map((t) =>
        t[0] === 'proof' ? ['proof', JSON.stringify(replacement)] : t,
      ),
    },
    lock,
  );
  const events = [...f.published.values()].map((e) =>
    e.kind === 7376
      ? finalizeEvent(
          { ...e, tags: e.tags.map((t) => (t[0] === 'e' ? [t[0], second.id, '', 'redeemed'] : t)) },
          key,
        )
      : e,
  );
  f.loser.query = async () => events;
  const states = f.mint.states.bind(f.mint);
  f.mint.states = async (proofs) =>
    Promise.all(
      proofs.map(async (p) =>
        p.secret === replacement.secret ? 'SPENT' : (await states([p]))[0]!,
      ),
    );
  await expect(receiveNutzap(second, f.loser)).rejects.toThrow();
  expect(summary(f.loser.database)).toEqual({ credits: 0, balance: 15 });
});
