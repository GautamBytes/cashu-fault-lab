import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools';
import { ReceivingKeys } from '../src/receiving-keys.js';

const key = (n: number) => Uint8Array.from([...Array(31).fill(0), n]);
const recipient = getPublicKey(key(1));
const secret = (n: number) => Buffer.from(key(n)).toString('hex');
function info(n: number, time: number, mint = 'http://127.0.0.1:3338', owner = 1): Event {
  return finalizeEvent(
    {
      kind: 10019,
      created_at: time,
      content: '',
      tags: [
        ['pubkey', getPublicKey(key(n))],
        ['mint', mint, 'sat'],
      ],
    },
    key(owner),
  );
}
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function path() {
  const dir = await mkdtemp(join(tmpdir(), 'receiving-keys-'));
  dirs.push(dir);
  return join(dir, 'keys.sqlite');
}
it('retains the old secret across restart while stale advertisements cannot roll back the sender', async () => {
  const file = await path();
  const old = info(2, 100),
    next = info(3, 101);
  const keys = new ReceivingKeys(file, recipient);
  keys.remember(old, secret(2));
  keys.remember(next, secret(3));
  keys.close();
  const restarted = new ReceivingKeys(file, recipient);
  try {
    restarted.remember(old);
    expect(restarted.current().id).toBe(next.id);
    expect(
      restarted
        .entries()
        .map((e) => e.secret)
        .sort(),
    ).toEqual([secret(2), secret(3)]);
  } finally {
    restarted.close();
  }
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
it('orders equal timestamps by the lowest event ID independently of arrival order', async () => {
  const events = [info(2, 100), info(3, 100)].sort((a, b) => a.id.localeCompare(b.id));
  for (const order of [events, [...events].reverse()]) {
    const keys = new ReceivingKeys(await path(), recipient);
    try {
      order.forEach((e) => keys.remember(e));
      expect(keys.current().id).toBe(events[0]!.id);
    } finally {
      keys.close();
    }
  }
});
it('keeps missing secrets absent and accepts a matching restored backup without rolling back', async () => {
  const keys = new ReceivingKeys(await path(), recipient);
  try {
    const old = info(2, 100),
      next = info(3, 101);
    keys.remember(old);
    keys.remember(next, secret(3));
    expect(keys.entries().find((e) => e.info.id === old.id)?.secret).toBeNull();
    keys.remember(old, secret(2));
    expect(keys.current().id).toBe(next.id);
    expect(keys.entries().find((e) => e.info.id === old.id)?.secret).toBe(secret(2));
  } finally {
    keys.close();
  }
});
it('rejects forged advertisements, wrong keys, changed trust and more than one rotation atomically', async () => {
  const keys = new ReceivingKeys(await path(), recipient);
  const old = info(2, 100);
  try {
    keys.remember(old, secret(2));
    const bad = [
      { ...info(3, 101), content: 'tampered' },
      info(3, 101, 'http://127.0.0.1:3338', 4),
      info(3, 101, 'http://127.0.0.1:9999'),
      info(3, 101, 'https://example.com'),
      info(1, 101),
    ];
    for (const event of bad) expect(() => keys.remember(event)).toThrow();
    expect(() => keys.remember(info(3, 101), secret(2))).toThrow();
    expect(keys.current().id).toBe(old.id);
    keys.remember(info(3, 101), secret(3));
    expect(() => keys.remember(info(4, 102), secret(4))).toThrow();
    expect(keys.entries()).toHaveLength(2);
  } finally {
    keys.close();
  }
});
it('blocks a missing old key before mint access, then redeems once after backup import', async () => {
  const { createNutzapSession } = await import('../src/session.js');
  const { receiveWithReceivingKeys } = await import('../src/rotating-receiver.js');
  const { Journal } = await import('../src/journal.js');
  const session = await createNutzapSession('rotation-boundary');
  const file = join(session.directory, 'keys.sqlite');
  const database = join(session.directory, 'wallet.sqlite');
  const keys = new ReceivingKeys(file, session.info.pubkey);
  try {
    keys.remember(session.info);
    const rotated = finalizeEvent(
      {
        ...session.info,
        created_at: session.info.created_at + 1,
        tags: session.info.tags.map((t) =>
          t[0] === 'pubkey' ? ['pubkey', getPublicKey(key(3))] : t,
        ),
      },
      session.key,
    );
    keys.remember(rotated, secret(3));
    const options = {
      database,
      key: session.key,
      relays: session.relays,
      mint: session.backend,
      publish: async () => {},
    };
    let calls = 0;
    const deny = async (): Promise<never> => {
      calls++;
      throw Error('Mint must not be called');
    };
    expect(
      await receiveWithReceivingKeys(
        session.event,
        {
          ...options,
          mint: { prepare: deny, swap: deny, restore: deny, verify: deny, states: deny },
        },
        file,
      ),
    ).toBe('recovery-blocked');
    expect(calls).toBe(0);
    const empty = new Journal(database);
    expect(empty.summary()).toEqual({ credits: 0, balance: 0 });
    empty.close();
    keys.remember(session.info, Buffer.from(session.lock).toString('hex'));
    for (let i = 0; i < 2; i++)
      expect(await receiveWithReceivingKeys(session.event, options, file)).toBe('complete');
    const db = new Journal(database);
    expect(db.summary()).toEqual({ credits: 1, balance: 15 });
    db.close();
    expect(keys.current().id).toBe(rotated.id);
    expect(session.backend.successfulSwaps).toBe(1);
  } finally {
    keys.close();
    await session.close();
  }
});
it('rejects ambiguous advertisements and unsupported units before changing persisted state', async () => {
  const keys = new ReceivingKeys(await path(), recipient);
  const old = info(2, 100);
  try {
    keys.remember(old, secret(2));
    const next = info(3, 101);
    for (const tags of [
      [...next.tags, ['pubkey', getPublicKey(key(4))]],
      [...next.tags, ['mint', 'http://127.0.0.1:9999', 'sat']],
      next.tags.map((t) => (t[0] === 'mint' ? [t[0], t[1]!, 'usd'] : t)),
      next.tags.map((t) => (t[0] === 'pubkey' ? [t[0], t[1]!, 'extra'] : t)),
    ])
      expect(() => keys.remember(finalizeEvent({ ...next, tags }, key(1)))).toThrow();
    expect(() => keys.remember(finalizeEvent({ ...next, created_at: -1 }, key(1)))).toThrow();
    expect(() =>
      keys.remember(finalizeEvent({ ...next, content: '界'.repeat(22000) }, key(1))),
    ).toThrow();
    expect(keys.current().id).toBe(old.id);
    expect(keys.entries()).toHaveLength(1);
  } finally {
    keys.close();
  }
});
