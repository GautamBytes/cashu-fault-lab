import { nip44, verifyEvent, type Event } from 'nostr-tools';
import { proofY, type NutzapProof } from './protocol.js';
import type { ReceiverOptions, RedemptionRecord } from './types.js';
import { verifyWalletPayloads } from './wallet-evidence.js';

/** A SPENT input is not a receipt. Require the complete signed wallet transition. */
export async function recoverFromPeer(
  record: RedemptionRecord,
  options: ReceiverOptions,
): Promise<{ events: Event[]; proofs: NutzapProof[] } | undefined> {
  if (!options.query) return;
  const reads = await Promise.allSettled(
    options.relays.map((relay) =>
      options.query!(relay, {
        kinds: [7375, 7376],
        authors: [record.zap.recipient],
      }),
    ),
  );
  const events = new Map<string, Event>();
  for (const read of reads) {
    if (read.status !== 'fulfilled' || !Array.isArray(read.value) || read.value.length > 128)
      continue;
    for (const raw of read.value) {
      try {
        if (Buffer.byteLength(JSON.stringify(raw)) > 262144) continue;
        const event: Event = JSON.parse(JSON.stringify(raw));
        if (
          event.pubkey === record.zap.recipient &&
          [7375, 7376].includes(event.kind) &&
          verifyEvent(event)
        )
          events.set(event.id, event);
      } catch {
        /* Ignore malformed relay entries; they cannot establish a receipt. */
      }
    }
  }
  const histories = [...events.values()].filter(
    (e) =>
      e.kind === 7376 &&
      e.tags.some((t) => t[0] === 'e' && t[1] === record.zap.event.id && t[3] === 'redeemed'),
  );
  // Conflicting transitions are never resolved by trusting a relay's ordering.
  if (histories.length !== 1) return;
  const history = histories[0]!;
  try {
    const redeemed = history.tags.filter((t) => t[0] === 'e');
    const senders = history.tags.filter((t) => t[0] === 'p');
    if (
      redeemed.length !== 1 ||
      senders.length !== 1 ||
      senders[0]?.[1] !== record.zap.event.pubkey
    )
      return;
    const conversation = nip44.v2.utils.getConversationKey(options.key, record.zap.recipient);
    const tags: unknown = JSON.parse(nip44.v2.decrypt(history.content, conversation));
    if (
      !Array.isArray(tags) ||
      !tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
    )
      return;
    const references = tags.filter((t) => t[0] === 'e');
    if (references.length !== 1 || references[0]?.length !== 4 || references[0]?.[3] !== 'created')
      return;
    const token = events.get(references[0]![1]!);
    if (!token || token.kind !== 7375) return;
    const payload = JSON.parse(nip44.v2.decrypt(token.content, conversation));
    if (
      !payload ||
      !Array.isArray(payload.proofs) ||
      payload.proofs.length < 1 ||
      payload.proofs.length > 64
    )
      return;
    const proofs: NutzapProof[] = payload.proofs;
    if (
      proofs.some(
        (p) =>
          !p ||
          typeof p !== 'object' ||
          typeof p.secret !== 'string' ||
          p.secret.length > 8192 ||
          typeof p.id !== 'string' ||
          !/^[0-9a-f]{16,66}$/.test(p.id) ||
          typeof p.C !== 'string' ||
          !/^0[23][0-9a-f]{64}$/.test(p.C) ||
          !Number.isSafeInteger(p.amount) ||
          p.amount < 1,
      )
    )
      return;
    const inputYs = new Set(record.zap.proofs.map(proofY));
    const ys = proofs.map(proofY);
    if (new Set(ys).size !== ys.length || ys.some((y) => inputYs.has(y))) return;
    if (
      !verifyWalletPayloads(payload, tags, {
        mint: record.zap.mint,
        amount: record.zap.amount - record.plan.fee,
        outputs: proofs,
      })
    )
      return;
    await options.mint.verify(proofs);
    const sources = await options.mint.states(record.zap.proofs);
    const outputs = await options.mint.states(proofs);
    if (
      sources.length !== record.zap.proofs.length ||
      sources.some((s) => s !== 'SPENT') ||
      outputs.length !== proofs.length ||
      outputs.some((s) => s !== 'UNSPENT')
    )
      return;
    return { events: [token, history], proofs };
  } catch {
    return;
  }
}
