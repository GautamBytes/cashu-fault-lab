import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { getPublicKey, nip44, type Event } from 'nostr-tools';
import { NostrFaultRelay } from '@cashu-fault-lab/nostr-fault-relay';
import {
  deriveFixtureKey,
  DoctorWallet,
  type FixtureMintWallet,
  type FixtureProof,
} from '../src/index.js';
import { publishLabEvent } from '../src/publish.js';

const MINT = 'http://127.0.0.1:3338';

function fakeProof(amount: number, secret: string): FixtureProof {
  return { id: '00ad268c4d1f5826', amount, secret, C: '02' + 'ab'.repeat(32) };
}

/** Deterministic fake mint: mints proofs, spends inputs (state moves to SPENT). */
function fakeMintWallet(): FixtureMintWallet {
  let counter = 0;
  return {
    mintProofs: (amount: number) => {
      counter += 1;
      return Promise.resolve([fakeProof(amount, `minted-${counter}`)]);
    },
    send: (amount: number, proofs: readonly FixtureProof[]) => {
      const total = proofs.reduce((sum, proof) => sum + proof.amount, 0);
      if (amount > total) return Promise.reject(new Error('amount exceeds balance'));
      counter += 1;
      const change = total - amount;
      return Promise.resolve({
        send: [fakeProof(amount, `sent-${counter}`)],
        keep: change > 0 ? [fakeProof(change, `change-${counter}`)] : [],
      });
    },
  };
}

async function collectEvents(relayUrl: string, pubkey: string): Promise<readonly Event[]> {
  const socket = new WebSocket(relayUrl);
  await once(socket, 'open');
  const events: Event[] = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as unknown[];
    if (message[0] === 'EVENT' && message[1] === 'sub') events.push(message[2] as Event);
  });
  socket.send(JSON.stringify(['REQ', 'sub', { kinds: [17375, 7375, 5], authors: [pubkey] }]));
  await new Promise<void>((resolve) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as unknown[];
      if (message[0] === 'EOSE') {
        socket.close();
        resolve();
      }
    });
  });
  return events;
}

function decryptToken(
  event: Event,
  secretKey: Uint8Array,
  pubkey: string,
): {
  mint: string;
  proofs: { amount: number; secret: string }[];
  del?: string[];
} {
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, pubkey);
  return JSON.parse(nip44.v2.decrypt(event.content, conversationKey)) as never;
}

async function withRelays(run: (urlA: string, urlB: string) => Promise<void>): Promise<void> {
  const relayA = new NostrFaultRelay();
  const relayB = new NostrFaultRelay();
  const urlA = await relayA.listen(0);
  const urlB = await relayB.listen(0);
  try {
    await run(urlA, urlB);
  } finally {
    await relayA.close();
    await relayB.close();
  }
}

function makeWallet(relays: readonly string[], secretKey: Uint8Array): DoctorWallet {
  return new DoctorWallet({
    mint: MINT,
    relays,
    secretKey,
    wallet: fakeMintWallet(),
    publish: async (relayUrl, event) => {
      const socket = new WebSocket(relayUrl);
      await once(socket, 'open');
      socket.send(JSON.stringify(['EVENT', event]));
      await new Promise<void>((resolve, reject) => {
        socket.on('message', (data) => {
          const message = JSON.parse(data.toString()) as unknown[];
          if (message[0] === 'OK' && message[1] === event.id) {
            socket.close();
            if (message[2] === true) resolve();
            else reject(new Error(`rejected: ${String(message[3])}`));
          }
        });
      });
    },
    now: () => 1_700_000_000,
  });
}

describe('deriveFixtureKey', () => {
  it('is deterministic and domain-separated', () => {
    const first = deriveFixtureKey('seed-a');
    expect(Buffer.from(first).toString('hex')).toBe(
      Buffer.from(deriveFixtureKey('seed-a')).toString('hex'),
    );
    expect(Buffer.from(first).toString('hex')).not.toBe(
      Buffer.from(deriveFixtureKey('seed-b')).toString('hex'),
    );
    expect(first).toHaveLength(32);
  });
});

describe('DoctorWallet relay behaviors', () => {
  it('publishes the wallet event and token event to every relay on mint', async () => {
    await withRelays(async (urlA, urlB) => {
      const key = deriveFixtureKey('mint-test');
      const wallet = makeWallet([urlA, urlB], key);
      await wallet.publishWalletEvent();
      const { tokenEventId, balance } = await wallet.mintTokens(16);
      expect(balance).toBe(16);

      for (const url of [urlA, urlB]) {
        const events = await collectEvents(url, wallet.pubkey);
        expect(events.some((event) => event.kind === 17375)).toBe(true);
        const token = events.find((event) => event.id === tokenEventId);
        expect(token?.kind).toBe(7375);
        const payload = decryptToken(token as Event, key, wallet.pubkey);
        expect(payload.proofs.reduce((sum, proof) => sum + proof.amount, 0)).toBe(16);
        expect(JSON.stringify(payload)).toContain('minted-1'); // encrypted channel only
      }
    });
  });

  it('publishes the public mint URL in event payloads when it differs from the ops URL', async () => {
    await withRelays(async (urlA, urlB) => {
      const key = deriveFixtureKey('public-mint');
      const publicMint = 'http://127.0.0.1:3348';
      const wallet = new DoctorWallet({
        mint: 'http://doctor-mint:3338',
        publicMint,
        relays: [urlA, urlB],
        secretKey: key,
        wallet: fakeMintWallet(),
        publish: async (relayUrl, event) => {
          const socket = new WebSocket(relayUrl);
          await once(socket, 'open');
          socket.send(JSON.stringify(['EVENT', event]));
          await new Promise<void>((resolve, reject) => {
            socket.on('message', (data) => {
              const message = JSON.parse(data.toString()) as unknown[];
              if (message[0] === 'OK' && message[1] === event.id) {
                socket.close();
                if (message[2] === true) resolve();
                else reject(new Error(`rejected: ${String(message[3])}`));
              }
            });
          });
        },
        now: () => 1_700_000_000,
      });
      expect(wallet.mint).toBe('http://doctor-mint:3338');
      expect(wallet.publicMint).toBe(publicMint);
      await wallet.publishWalletEvent();
      const { tokenEventId } = await wallet.mintTokens(8);
      const events = await collectEvents(urlA, wallet.pubkey);
      const walletEvent = events.find((event) => event.kind === 17375);
      expect(walletEvent).toBeDefined();
      const conversationKey = nip44.v2.utils.getConversationKey(key, wallet.pubkey);
      const walletPayload = JSON.parse(
        nip44.v2.decrypt((walletEvent as Event).content, conversationKey),
      ) as unknown[];
      expect(walletPayload).toContainEqual(['mint', publicMint]);
      const tokenEvent = events.find((event) => event.id === tokenEventId);
      const tokenPayload = decryptToken(tokenEvent as Event, key, wallet.pubkey);
      expect(tokenPayload.mint).toBe(publicMint);
    });
  });

  it('clean spend rolls over change and deletes the old token everywhere', async () => {
    await withRelays(async (urlA, urlB) => {
      const wallet = makeWallet([urlA, urlB], deriveFixtureKey('clean-spend'));
      const { tokenEventId } = await wallet.mintTokens(16);
      const spent = await wallet.spend(4, 'clean');
      expect(spent.balance).toBe(12);

      for (const url of [urlA, urlB]) {
        const events = await collectEvents(url, wallet.pubkey);
        expect(events.some((event) => event.id === spent.tokenEventId)).toBe(true);
        const deletion = events.find(
          (event) => event.kind === 5 && event.tags.some((tag) => tag[1] === tokenEventId),
        );
        expect(deletion).toBeDefined();
        expect(deletion?.tags).toContainEqual(['k', '7375']);
      }
    });
  });

  it('partial-delete leaves the old token live on relays that missed the deletion', async () => {
    await withRelays(async (urlA, urlB) => {
      const wallet = makeWallet([urlA, urlB], deriveFixtureKey('partial-delete'));
      const { tokenEventId } = await wallet.mintTokens(16);
      await wallet.spend(4, 'partial-delete');

      const eventsA = await collectEvents(urlA, wallet.pubkey);
      const eventsB = await collectEvents(urlB, wallet.pubkey);
      // Relay A: rollover + deletion. Relay B: rollover + old token, NO deletion.
      expect(eventsA.some((event) => event.kind === 5)).toBe(true);
      expect(eventsB.some((event) => event.kind === 5)).toBe(false);
      expect(eventsB.some((event) => event.id === tokenEventId)).toBe(true);
      expect(eventsB.some((event) => event.id === wallet.currentTokenEventId)).toBe(true);
    });
  });

  it('ghost spend changes mint state without touching relay state', async () => {
    await withRelays(async (urlA, urlB) => {
      const wallet = makeWallet([urlA, urlB], deriveFixtureKey('ghost-spend'));
      const { tokenEventId } = await wallet.mintTokens(16);
      const publishedBefore = wallet.publishedEvents.length;
      const result = await wallet.spend(4, 'ghost');
      // Ghost drops every local output so only the stale live event remains.
      expect(result.balance).toBe(0);
      expect(wallet.publishedEvents.length).toBe(publishedBefore);

      // The old token is still served as live on both relays (its proofs are
      // now spent at the mint, which the funded lanes verify via NUT-07).
      for (const url of [urlA, urlB]) {
        const events = await collectEvents(url, wallet.pubkey);
        expect(events.some((event) => event.id === tokenEventId)).toBe(true);
        expect(events.some((event) => event.kind === 5)).toBe(false);
      }
    });
  });

  it('ghost spend accepts a full-balance amount (mint wallet may clamp for fees)', async () => {
    await withRelays(async (urlA, urlB) => {
      const wallet = makeWallet([urlA, urlB], deriveFixtureKey('ghost-full-balance'));
      const { tokenEventId } = await wallet.mintTokens(16);
      const result = await wallet.spend(16, 'ghost');
      expect(result.balance).toBe(0);
      expect(result.tokenEventId).toBe(tokenEventId);
      for (const url of [urlA, urlB]) {
        const events = await collectEvents(url, wallet.pubkey);
        expect(events.some((event) => event.id === tokenEventId)).toBe(true);
        expect(events.some((event) => event.kind === 5)).toBe(false);
      }
    });
  });

  it('delete-only orphans proofs without spending them', async () => {
    await withRelays(async (urlA, urlB) => {
      const wallet = makeWallet([urlA, urlB], deriveFixtureKey('delete-only'));
      const { tokenEventId } = await wallet.mintTokens(16);
      const result = await wallet.spend(1, 'delete-only');
      expect(result.tokenEventId).toBeNull();
      expect(result.balance).toBe(16); // proofs remain valid locally

      for (const url of [urlA, urlB]) {
        const events = await collectEvents(url, wallet.pubkey);
        const deletion = events.find(
          (event) => event.kind === 5 && event.tags.some((tag) => tag[1] === tokenEventId),
        );
        expect(deletion).toBeDefined();
      }
    });
  });

  it('rejects invalid spend modes and overspending', async () => {
    const wallet = makeWallet(['ws://127.0.0.1:1'], deriveFixtureKey('invalid'));
    await expect(wallet.spend(1, 'nonsense' as never)).rejects.toThrow(/mode/u);
    await expect(wallet.spend(1, 'clean')).rejects.toThrow(/No live token event/u);
  });
});

describe('fixture key handling', () => {
  it('exposes pubkey and secret key for harness captures (lab only)', () => {
    const key = deriveFixtureKey('subject-test');
    const wallet = makeWallet(['ws://127.0.0.1:1'], key);
    expect(wallet.pubkey).toBe(getPublicKey(key));
    expect(wallet.secretKeyHex).toBe(Buffer.from(key).toString('hex'));
  });
});

describe('publishLabEvent', () => {
  it('publishes to a live relay and accepts docker service hostnames', async () => {
    const relay = new NostrFaultRelay();
    const loopbackUrl = await relay.listen(0);
    try {
      const key = deriveFixtureKey('publish-lab');
      const wallet = makeWallet([loopbackUrl], key);
      await wallet.publishWalletEvent();
      const events = await collectEvents(loopbackUrl, wallet.pubkey);
      const walletEvent = events.find((event) => event.kind === 17375);
      expect(walletEvent).toBeDefined();

      // Happy path against a real loopback relay.
      await publishLabEvent(loopbackUrl, walletEvent as Event);

      // Compose uses ws://relay-a:4400. Production NostrRelayClient rejects that
      // shape at validation time; the lab publisher only fails on connect.
      await expect(publishLabEvent('ws://relay-a:9', walletEvent as Event)).rejects.toThrow(
        /connection failed|timed out|closed before OK/u,
      );

      // Non-ws schemes are still rejected up front.
      await expect(
        publishLabEvent('http://example.test:4400', walletEvent as Event),
      ).rejects.toThrow('fixture relay URL must use ws or wss');
    } finally {
      await relay.close();
    }
  });
});
