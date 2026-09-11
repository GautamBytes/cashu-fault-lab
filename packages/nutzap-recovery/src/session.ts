import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { NostrFaultRelay } from '@cashu-fault-lab/nostr-fault-relay';
import { digest, validateNutzap } from './protocol.js';
import { FundedMint } from './funded-mint.js';
import { SimulatedMint } from './simulated-mint.js';
import { publishEvent, queryEvents } from './relay.js';

export async function createNutzapSession(seed: string, mintOption?: string) {
  const key = Uint8Array.from(Buffer.from(digest(`nip61-lab-subject\0${seed}`), 'hex'));
  const lock = Uint8Array.from(Buffer.from(digest(`nip61-lab-lock\0${seed}`), 'hex'));
  const sender = Uint8Array.from(Buffer.from(digest(`nip61-lab-sender\0${seed}`), 'hex'));
  const mintUrl = mintOption ?? 'http://127.0.0.1:3338';
  const backend = mintOption
    ? new FundedMint(mintUrl, Buffer.from(lock).toString('hex'))
    : new SimulatedMint(getPublicKey(lock), seed);
  const proofs =
    backend instanceof FundedMint ? await backend.source(getPublicKey(lock)) : backend.source();
  const directory = await mkdtemp(join(tmpdir(), 'cashu-nip61-'));
  const relayObjects = [new NostrFaultRelay(), new NostrFaultRelay()];
  try {
    const relays = await Promise.all(relayObjects.map((r) => r.listen()));
    const info = finalizeEvent(
      {
        kind: 10019,
        created_at: 1700000000,
        tags: [
          ['mint', mintUrl, 'sat'],
          ['pubkey', getPublicKey(lock)],
          ...relays.map((r) => ['relay', r]),
        ],
        content: '',
      },
      key,
    );
    const event = finalizeEvent(
      {
        kind: 9321,
        created_at: 1700000001,
        tags: [
          ['p', getPublicKey(key)],
          ['u', mintUrl],
          ['unit', 'sat'],
          ...proofs.map((p) => ['proof', JSON.stringify(p)]),
        ],
        content: '',
      },
      sender,
    );
    const zap = validateNutzap(event, info);
    await Promise.all(
      relays.map(async (r) => {
        await publishEvent(r, info);
        await publishEvent(r, event);
      }),
    );
    // Recipient-tag filtering is essential: the sender authored the nutzap.
    const inboxes = await Promise.all(
      relays.map((r) => queryEvents(r, { kinds: [9321], '#p': [info.pubkey], '#u': [mintUrl] })),
    );
    if (inboxes.some((events) => events.length !== 1 || events[0]?.id !== event.id))
      throw Error('Nutzap relay inbox mismatch');
    return {
      key,
      lock,
      backend,
      proofs,
      directory,
      relayObjects,
      relays,
      info,
      event,
      zap,
      inboxes,
      async client() {
        if (!(backend instanceof FundedMint)) return backend;
        const client = new FundedMint(mintUrl, Buffer.from(lock).toString('hex'));
        await client.initialize();
        return client;
      },
      async close() {
        await Promise.allSettled(relayObjects.map((r) => r.close()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.allSettled(relayObjects.map((r) => r.close()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export type NutzapSession = Awaited<ReturnType<typeof createNutzapSession>>;
