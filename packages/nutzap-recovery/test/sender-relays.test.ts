import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools';
import { Journal } from '../src/journal.js';
import { discoverSenderRelays } from '../src/sender-relays.js';

const key = Uint8Array.from([...Array(31).fill(0), 7]);
const sender = getPublicKey(key);
const sources = ['ws://127.0.0.1:4400/', 'ws://127.0.0.1:4401/'];
const list = (created_at: number, tags: string[][]) =>
  finalizeEvent({ kind: 10002, created_at, tags, content: '' }, key);

it('keeps the newest signed list across restart and stale answers, including unmarked read relays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sender-relays-'));
  const path = join(dir, 'wallet.sqlite');
  let db = new Journal(path);
  try {
    const newer = list(20, [
      ['r', sources[0]!, 'read'],
      ['r', sources[1]!],
      ['r', 'ws://127.0.0.1:4402', 'write'],
      ['r', sources[0]!, 'read'],
    ]);
    const older = list(10, [['r', 'ws://127.0.0.1:4403']]);
    expect(
      await discoverSenderRelays(db, sender, sources, async (relay, filter) => {
        expect(filter).toEqual({ kinds: [10002], authors: [sender] });
        return relay === sources[0] ? [newer] : [older];
      }),
    ).toEqual(sources);
    db.close();
    db = new Journal(path);
    expect(await discoverSenderRelays(db, sender, sources, async () => [older])).toEqual(sources);
    // Timestamp ties use the lowest event ID, independent of arrival order.
    const tied = [list(30, [['r', sources[0]!]]), list(30, [['r', sources[1]!]])].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    expect(
      await discoverSenderRelays(db, sender, sources, async () => [...tied].reverse()),
    ).toEqual([tied[0]!.tags[0]![1]]);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('ignores forged metadata and retries failed discovery instead of freezing an empty route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sender-relays-'));
  const db = new Journal(join(dir, 'wallet.sqlite'));
  try {
    const signed = list(20, [['r', sources[0]!]]);
    const forged: Event = { ...signed, tags: [['r', sources[1]!]] };
    await expect(
      discoverSenderRelays(db, sender, sources, async () => {
        throw Error('offline');
      }),
    ).rejects.toThrow();
    expect(await discoverSenderRelays(db, sender, sources, async () => [forged])).toEqual([]);
    expect(await discoverSenderRelays(db, sender, sources, async () => [signed])).toEqual([
      sources[0],
    ]);
    expect(
      await discoverSenderRelays(db, sender, sources, async () => {
        throw Error('offline');
      }),
    ).toEqual([sources[0]]);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  'wss://relay.example',
  'ws://localhost:4400',
  'ws://127.0.0.1:4400/#fragment',
  'ws://user@127.0.0.1:4400',
])('blocks unsupported destination %s before publication', async (url) => {
  const dir = await mkdtemp(join(tmpdir(), 'sender-relays-'));
  const db = new Journal(join(dir, 'wallet.sqlite'));
  try {
    await expect(
      discoverSenderRelays(db, sender, sources, async () => [list(20, [['r', url]])]),
    ).rejects.toThrow();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('honors withdrawals and rejects unbounded read lists without falling back to stale routes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sender-relays-'));
  const db = new Journal(join(dir, 'wallet.sqlite'));
  try {
    expect(
      await discoverSenderRelays(db, sender, sources, async () => [list(10, [['r', sources[0]!]])]),
    ).toEqual([sources[0]]);
    expect(
      await discoverSenderRelays(db, sender, sources, async () => [
        list(20, [['r', sources[0]!, 'write']]),
      ]),
    ).toEqual([]);
    expect(
      await discoverSenderRelays(db, sender, sources, async () => [list(10, [['r', sources[0]!]])]),
    ).toEqual([]);
    await expect(
      discoverSenderRelays(db, sender, sources, async () => [
        list(
          30,
          Array.from({ length: 5 }, (_, i) => ['r', `ws://127.0.0.1:${4500 + i}`]),
        ),
      ]),
    ).rejects.toThrow('Too many');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not cache wrong-author, future-dated, oversized or malformed signed metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sender-relays-'));
  const db = new Journal(join(dir, 'wallet.sqlite'));
  try {
    const other = Uint8Array.from([...Array(31).fill(0), 8]);
    const valid = list(10, [['r', sources[0]!]]);
    const events = [
      finalizeEvent(
        { kind: 10002, created_at: 20, content: '', tags: [['r', sources[1]!]] },
        other,
      ),
      list(Math.floor(Date.now() / 1000) + 3600, [['r', sources[1]!]]),
      finalizeEvent(
        { kind: 10002, created_at: 30, content: 'x'.repeat(65536), tags: [['r', sources[1]!]] },
        key,
      ),
      valid,
    ];
    expect(await discoverSenderRelays(db, sender, sources, async () => events)).toEqual([
      sources[0],
    ]);
    expect(db.relayList(sender)?.id).toBe(valid.id);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
