import { nip44, type Event } from 'nostr-tools';
import { queryEvents } from './relay.js';
import { verifyWalletPayloads } from './wallet-evidence.js';
import type { NutzapEvidence } from './evidence.js';
import type { NutzapProof } from './protocol.js';
import type { NutzapSession } from './session.js';
import type { RedemptionRecord } from './types.js';

export async function observeNutzap(
  session: Pick<NutzapSession, 'relays' | 'key' | 'zap' | 'backend' | 'proofs'> & {
    info: Event;
    event: Event;
  },
  record: RedemptionRecord,
  summary: { credits: number; balance: number },
  faultObserved: boolean,
  killedAfterSwap: boolean,
  completed: boolean,
  excludeEventIds: string[] = [],
): Promise<NutzapEvidence> {
  const { relays, info, key, event, zap, backend, proofs } = session;
  const views = (
    await Promise.all(
      relays.map((r) => queryEvents(r, { kinds: [7375, 7376], authors: [info.pubkey] })),
    )
  ).map((events) => events.filter((e) => !excludeEventIds.includes(e.id)));
  const tokens = views.map((v) => v.filter((e) => e.kind === 7375));
  const histories = views.map((v) => v.filter((e) => e.kind === 7376));
  const conversation = nip44.v2.utils.getConversationKey(key, info.pubkey);
  const outputProofs: NutzapProof[] = tokens[0]?.[0]
    ? JSON.parse(nip44.v2.decrypt(tokens[0][0].content, conversation)).proofs
    : [];
  const sourceStates = await backend.states(proofs);
  const outputStates = await backend.states(outputProofs);
  return {
    inputAmount: zap.amount,
    outputAmount: outputProofs.reduce((n, p) => n + p.amount, 0),
    fee: record.plan.fee,
    credits: summary.credits,
    creditedAmount: summary.balance,
    inputProofs: proofs.length,
    spentInputs: sourceStates.filter((s) => s === 'SPENT').length,
    outputProofs: outputProofs.length,
    unspentOutputs: outputStates.filter((s) => s === 'UNSPENT').length,
    tokenCounts: tokens.map((v) => v.length),
    historyCounts: histories.map((v) => v.length),
    relayEventsAgree:
      JSON.stringify(views[0]!.map((e) => e.id).sort()) ===
      JSON.stringify(views[1]!.map((e) => e.id).sort()),
    historyReferencesMatch: histories.every(
      (events, i) =>
        events.length === 1 &&
        events[0]!.tags.some((t) => t[0] === 'e' && t[1] === event.id && t[3] === 'redeemed') &&
        JSON.parse(nip44.v2.decrypt(events[0]!.content, conversation)).some(
          (t: string[]) => t[0] === 'e' && t[1] === tokens[i]?.[0]?.id && t[3] === 'created',
        ),
    ),
    walletPayloadsMatch: tokens.every((events, i) => {
      const token = events[0];
      const history = histories[i]?.[0];
      return (
        events.length === 1 &&
        histories[i]?.length === 1 &&
        !!token &&
        !!history &&
        record.events.some((e) => e.id === token.id) &&
        record.events.some((e) => e.id === history.id) &&
        history.tags.some((t) => t.length === 2 && t[0] === 'p' && t[1] === event.pubkey) &&
        verifyWalletPayloads(
          JSON.parse(nip44.v2.decrypt(token.content, conversation)),
          JSON.parse(nip44.v2.decrypt(history.content, conversation)),
          { mint: zap.mint, amount: summary.balance, outputs: record.plan.outputs },
        )
      );
    }),
    faultObserved: faultObserved,
    killedAfterSwap,
    completed,
  } satisfies NutzapEvidence;
}
