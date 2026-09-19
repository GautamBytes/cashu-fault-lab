import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey, nip44, type Event } from 'nostr-tools';
import { SimulatedMint } from '../src/simulated-mint.js';
import { Journal } from '../src/journal.js';
import { receiveNutzap } from '../src/receiver.js';
import { spendNutzap } from '../src/spend.js';
import { syncWallet } from '../src/wallet-sync.js';
import { validateNutzap } from '../src/protocol.js';
import type { ReceiverOptions } from '../src/types.js';

const key = Uint8Array.from([...Array(31).fill(0), 1]);
const lock = Uint8Array.from([...Array(31).fill(0), 2]);
const mintUrl = 'http://127.0.0.1:3338';
const conversation = nip44.v2.utils.getConversationKey(key, getPublicKey(key));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'post-spend-wallet-'));
  directories.push(directory);
  const mint = new SimulatedMint(getPublicKey(lock), 'post-spend');
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
    mint,
    relays: ['ws://127.0.0.1:4400'],
    publish: async (_: string, event: Event) => {
      published.set(event.id, event);
    },
    query: async () => [...published.values()],
  };
  const a: ReceiverOptions = { ...common, database: join(directory, 'a.sqlite') };
  const b: ReceiverOptions = { ...common, database: join(directory, 'b.sqlite') };
  await receiveNutzap(event, a);
  await receiveNutzap(event, b);
  const id = validateNutzap(event, info).id;
  const read = (database: string) => {
    const db = new Journal(database);
    try {
      return { record: db.get(id)!, summary: db.summary() };
    } finally {
      db.close();
    }
  };
  return { a, b, id, event, mint, published, read };
}
it.each([
  'author',
  'signature',
  'mint',
  'unit',
  'del',
  'duplicate-proof',
  'forged-proof',
  'amount',
  'conflict',
  'history-only',
])('rejects invalid post-spend relay evidence: %s', async (fault) => {
  const f = await fixture();
  await spendNutzap(f.id, 4, f.a);
  const spend = f.read(f.a.database).record.spend!;
  const token = spend.events.find((e) => e.kind === 7375)!;
  const body = JSON.parse(nip44.v2.decrypt(token.content, conversation));
  if (fault === 'mint') body.mint = 'http://127.0.0.1:9999';
  if (fault === 'unit') body.unit = 'usd';
  if (fault === 'del') body.del = ['00'.repeat(32)];
  if (fault === 'duplicate-proof') body.proofs.push(body.proofs[0]);
  if (fault === 'forged-proof') body.proofs[0].C = '02' + '00'.repeat(32);
  if (fault === 'amount') body.proofs[0].amount = 999;
  const changed = finalizeEvent(
    { ...token, content: nip44.v2.encrypt(JSON.stringify(body), conversation) },
    fault === 'author' ? lock : key,
  );
  if (fault === 'signature') changed.sig = '00'.repeat(64);
  f.published.delete(token.id);
  if (fault === 'conflict') f.published.set(token.id, token);
  if (fault !== 'history-only') f.published.set(changed.id, changed);
  expect(await syncWallet(f.id, f.b)).toBe('awaiting-peer');
  expect(f.read(f.b.database).summary).toEqual({ credits: 0, balance: 0 });
});
it.each(['PENDING', 'unavailable'])(
  'never advertises unverifiable proofs as spendable: %s',
  async (state) => {
    const f = await fixture();
    await spendNutzap(f.id, 4, f.a);
    const states = f.mint.states.bind(f.mint);
    f.b.mint = {
      ...f.mint,
      prepare: f.mint.prepare.bind(f.mint),
      swap: f.mint.swap.bind(f.mint),
      restore: f.mint.restore.bind(f.mint),
      verify: f.mint.verify.bind(f.mint),
      states: async (proofs) => {
        if (state === 'unavailable') throw Error('offline');
        return (await states(proofs)).map(() => 'PENDING');
      },
    };
    expect(await syncWallet(f.id, f.b)).toBe('awaiting-peer');
    expect(f.read(f.b.database).summary.balance).toBe(0);
  },
);
it('rejects forged deletion and preserves a valid current token', async () => {
  const f = await fixture();
  await spendNutzap(f.id, 4, f.a);
  const token = f.read(f.a.database).record.wallet!.token!;
  const forged = finalizeEvent(
    {
      kind: 5,
      created_at: 4,
      content: '',
      tags: [
        ['e', token.id],
        ['k', '7375'],
      ],
    },
    lock,
  );
  f.published.set(forged.id, forged);
  expect(await syncWallet(f.id, f.b)).toBe('complete');
  expect(f.read(f.b.database).summary.balance).toBe(10);
});
it('keeps tombstones across restart even if a stale mint response claims the old proofs are unspent', async () => {
  const f = await fixture();
  await spendNutzap(f.id, 4, f.a);
  expect(await syncWallet(f.id, f.b)).toBe('complete');
  const original = f.read(f.b.database).record.events.find((e) => e.kind === 7375)!;
  f.published.clear();
  f.published.set(original.id, original);
  f.mint.states = async (proofs) => proofs.map(() => 'UNSPENT');
  expect(await syncWallet(f.id, f.b)).toBe('complete');
  expect(f.read(f.b.database).summary.balance).toBe(10);
  await receiveNutzap(f.event, f.b);
  expect(f.read(f.b.database).summary).toEqual({ credits: 0, balance: 10 });
});
it('recovers publication using the original outbox without spending twice', async () => {
  const f = await fixture();
  const publish = f.a.publish;
  f.a.publish = async () => {
    throw Error('offline');
  };
  expect(await spendNutzap(f.id, 4, f.a)).toBe('publication-pending');
  const before = f.read(f.a.database).record.spend!;
  f.a.publish = publish;
  expect(await spendNutzap(f.id, 4, f.a)).toBe('complete');
  expect(f.read(f.a.database).record.spend!.events.map((e) => e.id)).toEqual(
    before.events.map((e) => e.id),
  );
  expect(f.mint.successfulSwaps).toBe(2);
  await expect(spendNutzap(f.id, 3, f.a)).rejects.toThrow('Conflicting spend amount');
});
it('keeps a prepared spend reserved while relay synchronization runs', async () => {
  const f = await fixture();
  const swap = f.mint.swap.bind(f.mint);
  f.mint.swap = async () => {
    throw Error('request lost before mint');
  };
  expect(await spendNutzap(f.id, 4, f.a)).toBe('recovery-blocked');
  expect(await syncWallet(f.id, f.a)).toBe('awaiting-peer');
  expect(f.read(f.a.database).summary.balance).toBe(0);
  f.mint.swap = swap;
  expect(await spendNutzap(f.id, 4, f.a)).toBe('complete');
  expect(f.read(f.a.database).summary.balance).toBe(10);
});
it('does not release a spend reservation created during an in-flight synchronization', async () => {
  const f = await fixture();
  f.mint.swap = async () => {
    throw Error('request not sent');
  };
  const checking = {
    ...f.a,
    mint: {
      prepare: f.mint.prepare.bind(f.mint),
      swap: f.mint.swap.bind(f.mint),
      restore: f.mint.restore.bind(f.mint),
      verify: f.mint.verify.bind(f.mint),
      states: async (proofs: Parameters<typeof f.mint.states>[0]) => {
        expect(await spendNutzap(f.id, 4, f.a)).toBe('recovery-blocked');
        return f.mint.states(proofs);
      },
    },
  };
  expect(await syncWallet(f.id, checking)).toBe('awaiting-peer');
  expect(f.read(f.a.database).summary.balance).toBe(0);
});
it('restores the exact prepared payment and change after a lost swap response', async () => {
  const f = await fixture();
  const swap = f.mint.swap.bind(f.mint);
  f.mint.swap = async (zap, plan) => {
    await swap(zap, plan);
    throw Error('response lost');
  };
  expect(await spendNutzap(f.id, 4, f.a)).toBe('complete');
  const saved = f.read(f.a.database);
  expect(saved.summary).toEqual({ credits: 1, balance: 10 });
  expect(saved.record.spend!.sent.reduce((n, p) => n + p.amount, 0)).toBe(4);
  expect(f.mint.successfulSwaps).toBe(2);
  expect(await syncWallet(f.id, f.b)).toBe('complete');
  expect(f.read(f.b.database).summary.balance).toBe(10);
});
it('remembers an authenticated deletion delivered before its token', async () => {
  const f = await fixture();
  await spendNutzap(f.id, 4, f.a);
  const token = f.read(f.a.database).record.wallet!.token!;
  const deletion = finalizeEvent(
    {
      kind: 5,
      created_at: 5,
      content: '',
      tags: [
        ['e', token.id],
        ['k', '7375'],
      ],
    },
    key,
  );
  f.published.delete(token.id);
  f.published.set(deletion.id, deletion);
  expect(await syncWallet(f.id, f.b)).toBe('awaiting-peer');
  f.published.delete(deletion.id);
  f.published.set(token.id, token);
  expect(await syncWallet(f.id, f.b)).toBe('awaiting-peer');
  expect(f.read(f.b.database).summary.balance).toBe(0);
});
