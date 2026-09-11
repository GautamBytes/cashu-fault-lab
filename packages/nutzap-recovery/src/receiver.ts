import { finalizeEvent, getPublicKey, nip44, type Event } from 'nostr-tools';
import { Journal } from './journal.js';
import { recoverFromPeer } from './peer.js';
import { validateNutzap, type NutzapProof } from './protocol.js';
import type { ReceiverOptions, ReceiveResult, RedemptionRecord } from './types.js';

function validateOutputs(record: RedemptionRecord, proofs: NutzapProof[]): void {
  const expected = record.plan.outputs;
  const amount = proofs.reduce((sum, p) => sum + p.amount, 0);
  if (
    proofs.length !== expected.length ||
    new Set(proofs.map((p) => p.secret)).size !== proofs.length ||
    proofs.some(
      (p) => !expected.some((o) => o.secret === p.secret && o.amount === p.amount && o.id === p.id),
    ) ||
    amount + record.plan.fee !== record.zap.amount
  )
    throw new Error('Recovered output identity or value mismatch');
}
function eventsFor(record: RedemptionRecord, proofs: NutzapProof[], key: Uint8Array): Event[] {
  const zap = record.zap;
  const conversation = nip44.v2.utils.getConversationKey(key, zap.recipient);
  const encrypt = (value: unknown) => nip44.v2.encrypt(JSON.stringify(value), conversation);
  const created_at = zap.event.created_at + 1;
  const token = finalizeEvent(
    {
      kind: 7375,
      created_at,
      tags: [],
      content: encrypt({ mint: zap.mint, unit: 'sat', proofs, del: [] }),
    },
    key,
  );
  const history = finalizeEvent(
    {
      kind: 7376,
      created_at,
      tags: [
        ['e', zap.event.id, '', 'redeemed'],
        ['p', zap.event.pubkey],
      ],
      content: encrypt([
        ['direction', 'in'],
        ['amount', String(zap.amount - record.plan.fee)],
        ['unit', 'sat'],
        ['e', token.id, '', 'created'],
      ]),
    },
    key,
  );
  return [token, history];
}
export async function receiveNutzap(
  event: Event,
  options: ReceiverOptions,
): Promise<ReceiveResult> {
  const zap = validateNutzap(event, options.info);
  if (
    getPublicKey(options.key) !== zap.recipient ||
    options.relays.length < 1 ||
    options.relays.length > 4
  )
    throw Error('Invalid receiver identity or relays');
  const db = new Journal(options.database);
  try {
    let record = db.get(zap.id);
    if (!record) {
      const plan = await options.mint.prepare(zap);
      if (
        !Number.isSafeInteger(plan.fee) ||
        plan.fee < 0 ||
        plan.outputs.length < 1 ||
        plan.outputs.length > 64 ||
        plan.outputs.some((o) => !Number.isSafeInteger(o.amount) || o.amount < 1) ||
        new Set(plan.outputs.map((o) => o.secret)).size !== plan.outputs.length ||
        plan.outputs.reduce((sum, o) => sum + o.amount, 0) + plan.fee !== zap.amount
      )
        throw Error('Invalid output plan');
      record = db.reserve(zap, plan);
    } else record = db.reserve(zap, record.plan);
    if (record.credit === null) {
      let proofs = await options.mint.restore(record.zap, record.plan);
      if (proofs.length === 0) {
        const states = await options.mint.states(record.zap.proofs);
        if (states.length !== record.zap.proofs.length) return 'recovery-blocked';
        if (states.includes('PENDING')) return 'pending';
        if (states.every((s) => s === 'UNSPENT')) {
          try {
            proofs = await options.mint.swap(record.zap, record.plan);
          } catch {
            proofs = await options.mint.restore(record.zap, record.plan);
          }
          if (proofs.length > 0) await options.afterSwap?.();
        } else proofs = await options.mint.restore(record.zap, record.plan);
      }
      if (proofs.length === 0) {
        if (!options.query) return 'recovery-blocked';
        const peer = await recoverFromPeer(record, options);
        if (!peer) return 'awaiting-peer';
        // This replicates an existing wallet balance; it is not a new mint credit.
        record = db.credit(zap.id, zap.amount - record.plan.fee, peer.events, peer.proofs, 'relay');
      } else {
        validateOutputs(record, proofs);
        const outputStates = await options.mint.states(proofs);
        if (outputStates.length !== proofs.length || outputStates.some((s) => s !== 'UNSPENT'))
          return 'recovery-blocked';
        record = db.credit(
          zap.id,
          zap.amount - record.plan.fee,
          eventsFor(record, proofs, options.key),
          proofs,
        );
      }
    }
    for (const relay of options.relays) {
      for (const out of record.events) {
        const target = JSON.stringify([relay, out.id]);
        if (record.published.includes(target)) continue;
        try {
          await options.publish(relay, out);
          db.acknowledge(zap.id, target);
        } catch {
          return 'publication-pending';
        }
      }
    }
    return 'complete';
  } finally {
    db.close();
  }
}
