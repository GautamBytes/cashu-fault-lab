import { finalizeEvent, nip44, getPublicKey, type Event } from 'nostr-tools';
import { Journal } from './journal.js';
import { proofY, type NutzapProof } from './protocol.js';
import type { ReceiverOptions, RedemptionRecord } from './types.js';

function spendEvents(record: RedemptionRecord, keep: NutzapProof[], key: Uint8Array): Event[] {
  const original = record.events.find((e) => e.kind === 7375)!;
  const spend = record.spend!;
  const conversation = nip44.v2.utils.getConversationKey(key, record.zap.recipient);
  const sign = (kind: number, content: string, tags: string[][] = []) =>
    finalizeEvent(
      {
        kind,
        content,
        tags,
        created_at: original.created_at + 1,
      },
      key,
    );
  const encrypt = (value: unknown) => nip44.v2.encrypt(JSON.stringify(value), conversation);
  const token = sign(
    7375,
    encrypt({ mint: record.zap.mint, unit: 'sat', proofs: keep, del: [original.id] }),
  );
  const deletion = sign(5, '', [
    ['e', original.id],
    ['k', '7375'],
  ]);
  const history = sign(
    7376,
    encrypt([
      ['direction', 'out'],
      ['amount', String(spend.amount + spend.plan.fee)],
      ['unit', 'sat'],
      ['e', original.id, '', 'destroyed'],
      ['e', token.id, '', 'created'],
    ]),
  );
  return [token, deletion, history];
}

/** One partial spend from an already synchronized lab receipt, with a durable outbox. */
export async function spendNutzap(
  id: string,
  amount: number,
  options: ReceiverOptions & {
    afterPublication?: () => Promise<void>;
  },
): Promise<'complete' | 'publication-pending' | 'recovery-blocked'> {
  const db = new Journal(options.database);
  try {
    let record = db.get(id);
    if (
      !record ||
      record.credit === null ||
      getPublicKey(options.key) !== record.zap.recipient ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount >= record.credit
    )
      throw Error('Invalid partial spend');
    if (!record.spend) {
      if (!options.mint.prepareSpend || !record.wallet?.proofs.length)
        throw Error('Spend unavailable');
      const inputs = record.wallet.proofs;
      const plan = await options.mint.prepareSpend(inputs, amount);
      const sum = (proofs: { amount: number }[]) => proofs.reduce((n, p) => n + p.amount, 0);
      if (
        !Number.isSafeInteger(plan.fee) ||
        plan.fee < 0 ||
        !plan.outputs.length ||
        plan.outputs.length > 64 ||
        plan.outputs.some((p) => !Number.isSafeInteger(p.amount) || p.amount < 1) ||
        new Set(plan.outputs.map((p) => p.secret)).size !== plan.outputs.length ||
        new Set(plan.sendSecrets).size !== plan.sendSecrets.length ||
        !plan.sendSecrets.length ||
        plan.sendSecrets.some((s) => !plan.outputs.some((p) => p.secret === s)) ||
        sum(plan.outputs.filter((p) => plan.sendSecrets.includes(p.secret))) !== amount ||
        sum(plan.outputs) + plan.fee !== sum(inputs) ||
        sum(plan.outputs) <= amount
      )
        throw Error('Invalid spend output plan');
      record = db.prepareSpend(id, amount, plan);
    }
    if (record.spend!.amount !== amount) throw Error('Conflicting spend amount');
    if (!record.spend!.events.length) {
      const plan = record.spend!.plan;
      const conversation = nip44.v2.utils.getConversationKey(options.key, record.zap.recipient);
      const original = record.events.find((e) => e.kind === 7375)!;
      const inputs: NutzapProof[] = JSON.parse(
        nip44.v2.decrypt(original.content, conversation),
      ).proofs;
      const spending = {
        ...record.zap,
        proofs: inputs,
        amount: inputs.reduce((n, p) => n + p.amount, 0),
      };
      let outputs = await options.mint.restore(spending, plan);
      if (!outputs.length) {
        const states = await options.mint.states(inputs);
        if (states.length !== inputs.length || states.some((s) => s !== 'UNSPENT'))
          return 'recovery-blocked';
        try {
          outputs = await options.mint.swap(spending, plan);
        } catch {
          outputs = await options.mint.restore(spending, plan);
        }
      }
      if (
        outputs.length !== plan.outputs.length ||
        new Set(outputs.map(proofY)).size !== outputs.length ||
        outputs.some(
          (p) =>
            !plan.outputs.some(
              (q) => p.secret === q.secret && p.id === q.id && p.amount === q.amount,
            ),
        )
      )
        return 'recovery-blocked';
      await options.mint.verify(outputs);
      const states = await options.mint.states(outputs);
      if (states.length !== outputs.length || states.some((s) => s !== 'UNSPENT'))
        return 'recovery-blocked';
      const keep = outputs.filter((p) => !plan.sendSecrets.includes(p.secret));
      const sent = outputs.filter((p) => plan.sendSecrets.includes(p.secret));
      record = db.finishSpend(id, spendEvents(record, keep, options.key), keep, sent);
    }
    for (const relay of options.relays) {
      for (const event of record.spend!.events) {
        const target = JSON.stringify([relay, event.id]);
        if (record.published.includes(target)) continue;
        try {
          await options.publish(relay, event);
        } catch {
          return 'publication-pending';
        }
        db.acknowledge(id, target);
        await options.afterPublication?.();
      }
    }
    return 'complete';
  } finally {
    db.close();
  }
}
