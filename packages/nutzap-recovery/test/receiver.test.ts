import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { receiveNutzap } from '../src/receiver.js';
import { Journal } from '../src/journal.js';
import type { MintPort, PreparedRedemption } from '../src/types.js';
const key = Uint8Array.from([...Array(31).fill(0), 1]);
const lock = Uint8Array.from([...Array(31).fill(0), 2]);
const mint = 'http://127.0.0.1:3338';
const relays = ['ws://127.0.0.1:4400', 'ws://127.0.0.1:4401'];
const info = finalizeEvent(
  {
    kind: 10019,
    created_at: 1,
    content: '',
    tags: [
      ['mint', mint],
      ['pubkey', getPublicKey(lock)],
    ],
  },
  key,
);
const proof = {
  id: '001234567890abcd',
  amount: 16,
  secret: JSON.stringify(['P2PK', { nonce: 'n', data: `02${getPublicKey(lock)}` }]),
  C: `02${getPublicKey(key)}`,
  dleq: { e: '01'.repeat(32), s: '02'.repeat(32), r: '03'.repeat(32) },
};
const event = finalizeEvent(
  {
    kind: 9321,
    created_at: 2,
    content: '',
    tags: [
      ['p', getPublicKey(key)],
      ['u', mint],
      ['proof', JSON.stringify(proof)],
    ],
  },
  lock,
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'nutzap-test-'));
  directories.push(dir);
  const plan: PreparedRedemption = {
    material: 'private-output-plan',
    fee: 1,
    outputs: [{ id: proof.id, secret: 'fresh-output-secret', amount: 15 }],
  };
  const output = { ...proof, secret: 'fresh-output-secret', amount: 15 };
  let swaps = 0,
    spent = false,
    pending = false;
  const port: MintPort = {
    verify: async () => {},
    prepare: async () => plan,
    swap: async () => {
      if (spent) throw Error('spent');
      swaps++;
      spent = true;
      return [output];
    },
    restore: async () => (spent ? [output] : []),
    states: async (proofs) =>
      proofs.map((p) =>
        p.secret === proof.secret ? (pending ? 'PENDING' : spent ? 'SPENT' : 'UNSPENT') : 'UNSPENT',
      ),
  };
  const published = new Map<string, Set<string>>();
  const publish = async (relay: string, e: { id: string }) => {
    const ids = published.get(relay) ?? new Set();
    ids.add(e.id);
    published.set(relay, ids);
  };
  return {
    database: join(dir, 'wallet.sqlite'),
    key,
    info,
    relays,
    mint: port,
    publish,
    published,
    swaps: () => swaps,
    setPending: (p: boolean) => {
      pending = p;
    },
  };
}
describe('durable nutzap recovery', () => {
  it('credits once across concurrent and repeated delivery and reuses the outbox', async () => {
    const f = await fixture();
    await Promise.all([receiveNutzap(event, f), receiveNutzap(event, f)]);
    expect(await receiveNutzap(event, f)).toBe('complete');
    const db = new Journal(f.database);
    try {
      expect(db.summary()).toEqual({ credits: 1, balance: 15 });
    } finally {
      db.close();
    }
    expect(f.swaps()).toBe(1);
    expect([...f.published.values()].map((s) => s.size)).toEqual([2, 2]);
  });
  it('restores saved outputs after a crash after swap but before committing credit', async () => {
    const f = await fixture();
    await expect(
      receiveNutzap(event, {
        ...f,
        afterSwap: async () => {
          throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(await receiveNutzap(event, f)).toBe('complete');
    expect(f.swaps()).toBe(1);
  });
  it('does not spend pending inputs or mistake unavailable restored outputs for success', async () => {
    const f = await fixture();
    f.setPending(true);
    expect(await receiveNutzap(event, f)).toBe('pending');
    expect(f.swaps()).toBe(0);
    f.setPending(false);
    f.mint.swap = async () => {
      throw Error('lost');
    };
    f.mint.states = async (proofs) => proofs.map(() => 'SPENT');
    expect(await receiveNutzap(event, f)).toBe('recovery-blocked');
  });
  it('rejects incorrect restored output identity even when the amount matches', async () => {
    const f = await fixture();
    f.mint.restore = async () => [{ ...proof, amount: 15, secret: 'different-output' }];
    await expect(receiveNutzap(event, f)).rejects.toThrow('output');
  });
  it('retries a partial publication without swapping or crediting again', async () => {
    const f = await fixture();
    let fail = true;
    const publish = async (r: string, e: { id: string }) => {
      await f.publish(r, e);
      if (fail && r === relays[1]) throw Error('lost OK');
    };
    expect(await receiveNutzap(event, { ...f, publish })).toBe('publication-pending');
    fail = false;
    expect(await receiveNutzap(event, { ...f, publish })).toBe('complete');
    expect(f.swaps()).toBe(1);
    expect([...f.published.values()].map((s) => s.size)).toEqual([2, 2]);
  });
  it('converges when pending inputs become available and keeps the journal private', async () => {
    const f = await fixture();
    f.setPending(true);
    expect(await receiveNutzap(event, f)).toBe('pending');
    f.setPending(false);
    expect(await receiveNutzap(event, f)).toBe('complete');
    expect(f.swaps()).toBe(1);
    expect((await stat(f.database)).mode & 0o777).toBe(0o600);
  });
  it('deduplicates economic proofs even when a different sender republishes them', async () => {
    const f = await fixture();
    expect(await receiveNutzap(event, f)).toBe('complete');
    const republished = finalizeEvent(
      { kind: event.kind, created_at: 3, content: 'duplicate', tags: [...event.tags].reverse() },
      key,
    );
    expect(republished.id).not.toBe(event.id);
    expect(await receiveNutzap(republished, f)).toBe('complete');
    expect(f.swaps()).toBe(1);
    expect([...f.published.values()].map((s) => s.size)).toEqual([2, 2]);
  });
  it('rejects partially overlapping proof sets without a second swap or credit', async () => {
    const f = await fixture();
    await receiveNutzap(event, f);
    const extra = {
      ...proof,
      secret: JSON.stringify(['P2PK', { nonce: 'different', data: `02${getPublicKey(lock)}` }]),
    };
    const overlapping = finalizeEvent(
      {
        kind: 9321,
        created_at: 3,
        content: '',
        tags: [...event.tags, ['proof', JSON.stringify(extra)]],
      },
      lock,
    );
    f.mint.prepare = async () => ({
      material: 'other-plan',
      fee: 1,
      outputs: [{ id: proof.id, secret: 'another-output', amount: 31 }],
    });
    await expect(receiveNutzap(overlapping, f)).rejects.toThrow();
    expect(f.swaps()).toBe(1);
    const db = new Journal(f.database);
    try {
      expect(db.summary()).toEqual({ credits: 1, balance: 15 });
    } finally {
      db.close();
    }
  });
  it('does not credit recovered outputs that are already spent', async () => {
    const f = await fixture();
    await expect(
      receiveNutzap(event, {
        ...f,
        afterSwap: async () => {
          throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    f.mint.states = async (proofs) => proofs.map(() => 'SPENT');
    expect(await receiveNutzap(event, f)).toBe('recovery-blocked');
    const db = new Journal(f.database);
    try {
      expect(db.summary()).toEqual({ credits: 0, balance: 0 });
    } finally {
      db.close();
    }
    expect(f.published.size).toBe(0);
  });
});
