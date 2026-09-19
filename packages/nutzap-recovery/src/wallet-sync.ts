import { getPublicKey, nip44, verifyEvent, type Event } from 'nostr-tools';
import { Journal } from './journal.js';
import { proofY, type NutzapProof } from './protocol.js';
import type { ReceiverOptions } from './types.js';

function proofsValid(value: unknown): value is NutzapProof[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    value.every(
      (p) =>
        p &&
        typeof p === 'object' &&
        typeof p.secret === 'string' &&
        p.secret.length <= 8192 &&
        typeof p.id === 'string' &&
        /^[0-9a-f]{16,66}$/.test(p.id) &&
        typeof p.C === 'string' &&
        /^0[23][0-9a-f]{64}$/.test(p.C) &&
        Number.isSafeInteger(p.amount) &&
        p.amount > 0,
    )
  );
}

/** Bounded NIP-60 reconciliation: the initial receipt and one replacement token. */
export async function syncWallet(
  id: string,
  options: ReceiverOptions,
): Promise<'complete' | 'awaiting-peer'> {
  const db = new Journal(options.database);
  try {
    const record = db.get(id);
    if (
      !record ||
      record.credit === null ||
      !options.query ||
      getPublicKey(options.key) !== record.zap.recipient
    )
      throw Error('Missing synchronized wallet');
    // Relay reads cannot release inputs reserved by an unfinished local spend.
    if (record.spend && !record.spend.events.length) return 'awaiting-peer';
    const original = record.events.find((e) => e.kind === 7375)!;
    const retired = new Set(record.wallet?.retired ?? []);
    const reads = await Promise.allSettled(
      options.relays.map((r) =>
        options.query!(r, {
          kinds: [7375, 5],
          authors: [record.zap.recipient],
        }),
      ),
    );
    const events = new Map<string, Event>();
    const local = [original, ...(record.wallet?.token ? [record.wallet.token] : [])];
    const batches = [
      local,
      ...reads.flatMap((r) =>
        r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length <= 128
          ? [r.value]
          : [],
      ),
    ];
    for (const batch of batches)
      for (const raw of batch) {
        try {
          if (Buffer.byteLength(JSON.stringify(raw)) > 262144) continue;
          const event: Event = JSON.parse(JSON.stringify(raw));
          if (
            event.pubkey !== record.zap.recipient ||
            ![7375, 5].includes(event.kind) ||
            !verifyEvent(event)
          )
            continue;
          events.set(event.id, event);
        } catch {
          /* Malformed events cannot establish a wallet balance. */
        }
      }
    for (const event of events.values()) {
      if (
        event.kind === 5 &&
        event.tags.some((t) => t.length === 2 && t[0] === 'k' && t[1] === '7375')
      ) {
        for (const tag of event.tags)
          if (tag[0] === 'e' && typeof tag[1] === 'string' && /^[0-9a-f]{64}$/.test(tag[1]))
            retired.add(tag[1]!);
      }
    }
    const conversation = nip44.v2.utils.getConversationKey(options.key, record.zap.recipient);
    const candidates: { event: Event; proofs: NutzapProof[]; del: string[] }[] = [];
    for (const event of events.values()) {
      if (event.kind !== 7375 || retired.has(event.id)) continue;
      try {
        const body = JSON.parse(nip44.v2.decrypt(event.content, conversation));
        if (
          body?.mint !== record.zap.mint ||
          body.unit !== 'sat' ||
          !proofsValid(body.proofs) ||
          !Array.isArray(body.del)
        )
          continue;
        const proofs: NutzapProof[] = body.proofs;
        const root = event.id === original.id;
        if (root ? body.del.length !== 0 : body.del.length !== 1 || body.del[0] !== original.id)
          continue;
        const amount = proofs.reduce((n, p) => n + p.amount, 0);
        if (
          !Number.isSafeInteger(amount) ||
          amount > record.credit ||
          new Set(proofs.map(proofY)).size !== proofs.length
        )
          continue;
        await options.mint.verify(proofs);
        const states = await options.mint.states(proofs);
        if (states.length !== proofs.length || states.some((s) => s !== 'UNSPENT')) {
          if (states.length === proofs.length && states.some((s) => s === 'SPENT'))
            retired.add(event.id);
          continue;
        }
        candidates.push({ event, proofs, del: body.del });
      } catch {
        /* Fail closed on invalid encryption, proofs or unavailable mint state. */
      }
    }
    const live = candidates.filter((c) => !retired.has(c.event.id));
    if (live.length !== 1) {
      db.wallet(id, null, [], [...retired]);
      return 'awaiting-peer';
    }
    const selected = live[0]!;
    return db.wallet(id, selected.event, selected.proofs, [...retired, ...selected.del])
      ? 'complete'
      : 'awaiting-peer';
  } finally {
    db.close();
  }
}
