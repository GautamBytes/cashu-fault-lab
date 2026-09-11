import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, getPublicKey, nip44, type Event } from 'nostr-tools';
import { NostrFaultRelay } from '@cashu-fault-lab/nostr-fault-relay';
import { digest, validateNutzap, type NutzapProof } from './protocol.js';
import { Journal } from './journal.js';
import { FundedMint } from './funded-mint.js';
import { SimulatedMint } from './simulated-mint.js';
import { publishEvent, queryEvents } from './relay.js';
import { runReceiverProcess } from './process.js';
import {
  evidenceFingerprint,
  verifyNutzapEvidence,
  type NutzapEvidence,
  type NutzapReport,
} from './evidence.js';
import type { MintPort } from './types.js';
import { verifyWalletPayloads } from './wallet-evidence.js';
export { verifyNutzapEvidence } from './evidence.js';
export const SCENARIOS = [
  'duplicate-relays',
  'concurrent-redemption',
  'crash-after-swap',
  'swap-response-lost',
  'publish-response-lost',
] as const;
export interface NutzapRunOptions {
  mintUrl?: string;
}
export function validateRun(id: string, seed: string): void {
  if (!SCENARIOS.some((s) => s === id)) throw Error('Unknown NIP-61 recovery scenario');
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 256)
    throw Error('Nutzap seed must contain 1-256 characters');
}
export async function runNutzapScenario(
  id: string,
  seed: string,
  options: NutzapRunOptions = {},
): Promise<NutzapReport> {
  validateRun(id, seed);
  const key = Uint8Array.from(Buffer.from(digest(`nip61-lab-subject\0${seed}`), 'hex'));
  const lock = Uint8Array.from(Buffer.from(digest(`nip61-lab-lock\0${seed}`), 'hex'));
  const sender = Uint8Array.from(Buffer.from(digest(`nip61-lab-sender\0${seed}`), 'hex'));
  const mintUrl = options.mintUrl ?? 'http://127.0.0.1:3338';
  const backend = options.mintUrl
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
    let lostSwap = false;
    let prepares = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mint: MintPort = {
      prepare: async (z) => {
        const plan = await backend.prepare(z);
        prepares++;
        if (prepares === 2) release();
        if (id === 'concurrent-redemption') await barrier;
        return plan;
      },
      swap: async (z, p) => {
        const result = await backend.swap(z, p);
        if (id === 'swap-response-lost' && !lostSwap) {
          lostSwap = true;
          throw Error('Injected response loss');
        }
        return result;
      },
      restore: (z, p) => backend.restore(z, p),
      states: (p) => backend.states(p),
    };
    if (id === 'publish-response-lost')
      relayObjects[1]!.control.setRule({ action: 'drop_ok', count: 1, kind: 7376 });
    const database = join(directory, 'wallet.sqlite');
    // Initialize schema before workers race; operations still use independent connections.
    new Journal(database).close();
    const input = {
      database,
      keyHex: Buffer.from(key).toString('hex'),
      info,
      event,
      relays,
      pauseAfterSwap: false,
    };
    let killedAfterSwap = false;
    let completed = false;
    let observed = false;
    if (id === 'concurrent-redemption') {
      const settled = await Promise.allSettled([
        runReceiverProcess(input, mint, publishEvent),
        runReceiverProcess(input, mint, publishEvent),
      ]);
      const results = settled.map((r) => {
        if (r.status === 'rejected') throw Error('Concurrent receiver failed');
        return r.value;
      });
      observed = prepares === 2;
      completed = results.every((r) => r === 'complete');
    } else if (id === 'crash-after-swap') {
      const first = await runReceiverProcess(
        { ...input, pauseAfterSwap: true },
        mint,
        publishEvent,
      );
      const before = new Journal(database);
      try {
        killedAfterSwap =
          first === 'killed' &&
          before.summary().credits === 0 &&
          (await backend.states(proofs)).every((s) => s === 'SPENT');
      } finally {
        before.close();
      }
      observed = killedAfterSwap;
    } else {
      const first = await runReceiverProcess(
        { ...input, event: inboxes[0]![0]! },
        mint,
        publishEvent,
      );
      completed = first === 'complete';
      observed =
        id === 'duplicate-relays'
          ? inboxes.length === 2
          : id === 'swap-response-lost'
            ? lostSwap
            : relayObjects[1]!.snapshot().rules.some((r) => r.applied === 1) &&
              first === 'publication-pending';
    }
    // Faults are finite. Repeat delivery after recovery must remain a no-op economically.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await runReceiverProcess(
        { ...input, event: inboxes[1]![0]! },
        mint,
        publishEvent,
      );
      completed = result === 'complete';
      if (completed) break;
    }
    const db = new Journal(database);
    const record = db.get(zap.id);
    const summary = db.summary();
    db.close();
    if (!record) throw Error('Nutzap journal missing prepared record');
    const views = await Promise.all(
      relays.map((r) => queryEvents(r, { kinds: [7375, 7376], authors: [info.pubkey] })),
    );
    const tokens = views.map((v) => v.filter((e) => e.kind === 7375));
    const histories = views.map((v) => v.filter((e) => e.kind === 7376));
    const conversation = nip44.v2.utils.getConversationKey(key, info.pubkey);
    const outputProofs: NutzapProof[] = tokens[0]?.[0]
      ? JSON.parse(nip44.v2.decrypt(tokens[0][0].content, conversation)).proofs
      : [];
    const sourceStates = await backend.states(proofs);
    const outputStates = await backend.states(outputProofs);
    const evidence: NutzapEvidence = {
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
      faultObserved: observed,
      killedAfterSwap,
      completed,
    };
    const verified = verifyNutzapEvidence(evidence, id);
    return {
      schemaVersion: 1,
      suite: 'nip61-recovery-v1',
      scenarioId: id,
      mode: options.mintUrl ? 'funded' : 'simulated',
      seedHash: digest(`nip61-recovery-seed-v1\0${seed}`),
      status: verified.ok ? 'passed' : 'failed',
      evidence,
      failures: verified.failures,
      fingerprint: evidenceFingerprint(evidence),
      implementations: {
        receiver: 'cashu-fault-lab/nip61-shared-journal-v1',
        mint: options.mintUrl
          ? 'cashu-ts/4.7.2 + operator-provided loopback mint'
          : 'simulated-mint/v1',
        relay: 'cashu-fault-lab/nostr-fault-relay',
      },
    };
  } finally {
    await Promise.allSettled(relayObjects.map((r) => r.close()));
    await rm(directory, { recursive: true, force: true });
  }
}
