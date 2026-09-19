import { join, isAbsolute } from 'node:path';
import { nip44 } from 'nostr-tools';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { snapshot } from './cdk.js';
import { runCdkReceiver } from './cdk-process.js';
import type { WorkerInput } from './nutzap-worker.js';
import { createNutzapSession } from './session.js';
import { runReceiverProcess } from './process.js';
import { publishEvent, queryEvents } from './relay.js';
import { syncWallet } from './wallet-sync.js';
import { observeNutzap } from './observation.js';
import { digest, type NutzapProof } from './protocol.js';
import { evidenceFingerprint, verifyNutzapEvidence, type NutzapReport } from './evidence.js';

export async function runPostSpendScenario(
  id: string,
  seed: string,
  mintUrl?: string,
  binary?: string,
): Promise<NutzapReport> {
  const native = id.startsWith('cdk-');
  if (native) {
    if (!mintUrl || !binary)
      throw Error('CDK scenarios require a disposable mint URL and receiver binary');
    if (!isAbsolute(binary)) throw Error('CDK receiver binary must be an absolute executable path');
    await access(binary, constants.X_OK);
  }
  const cdkIndex = native ? (id.startsWith('cdk-peer-') ? 1 : 0) : -1;
  const session = await createNutzapSession(seed, mintUrl);
  const { directory, key, info, event, zap, relays, relayObjects, backend } = session;
  try {
    const databases = ['wallet-a.sqlite', 'wallet-b.sqlite'].map((name) => join(directory, name));
    const clients = await Promise.all([session.client(), session.client()]);
    const inputs = databases.map((database) => ({
      database,
      keyHex: Buffer.from(key).toString('hex'),
      info,
      event,
      relays,
      pauseAfterSwap: false,
      syncPeers: true,
    }));
    const read = (i: number) => snapshot(databases[i]!, zap.id);
    let cdkProcessObserved = false,
      cdkSpendObserved = false,
      cdkSyncObserved = false;
    const run = (i: number, extra: Partial<WorkerInput> & { syncWallet?: boolean } = {}) => {
      const input = { ...inputs[i]!, ...extra };
      if (i !== cdkIndex) return runReceiverProcess(input, clients[i]!, publishEvent);
      return runCdkReceiver(
        binary!,
        input,
        Buffer.from(session.lock).toString('hex'),
        async (phase) => {
          cdkProcessObserved = true;
          if (phase === 'spend-prepared') cdkSpendObserved = true;
          if (phase === 'after-wallet-sync') cdkSyncObserved = true;
          return phase === 'after-publication' && extra.pauseAfterPublication ? 'kill' : 'continue';
        },
      );
    };
    const sync = (i: number) =>
      i === cdkIndex
        ? run(i, { syncWallet: true })
        : syncWallet(zap.id, {
            database: databases[i]!,
            key,
            info,
            relays,
            mint: clients[i]!,
            publish: publishEvent,
            query: queryEvents,
          });
    const views = () =>
      Promise.all(
        relays.map((r) => queryEvents(r, { kinds: [7375, 7376, 5], authors: [info.pubkey] })),
      );
    for (let i = 0; i < inputs.length; i++) {
      if ((await run(i)) !== 'complete') throw Error('Initial wallet synchronization failed');
    }
    const initial = read(0);
    // The original redemption evidence is a snapshot before the spend.
    const evidence = await observeNutzap(
      session,
      initial.record,
      initial.summary,
      true,
      false,
      true,
    );
    const original = initial.record.events.find((e) => e.kind === 7375)!;
    const conversation = nip44.v2.utils.getConversationKey(key, info.pubkey);
    const originalProofs: NutzapProof[] = JSON.parse(
      nip44.v2.decrypt(original.content, conversation),
    ).proofs;
    const crash = id.endsWith('publication-crash');
    const first = await run(0, { spendAmount: 4, pauseAfterPublication: crash });
    const prepared = read(0).record.spend!;
    if (!prepared) throw Error('Missing durable spend');
    const outboxIds = prepared.events.map((e) => e.id);
    const partial = await views();
    const publicationCrashObserved =
      first === 'killed' &&
      partial.reduce((n, v) => n + v.filter((e) => outboxIds.includes(e.id)).length, 0) === 1 &&
      (await backend.states(originalProofs)).every((s) => s === 'SPENT');
    if (crash ? !publicationCrashObserved : first !== 'complete')
      throw Error('Spend fault was not exercised');
    clients[0] = await session.client();
    if ((await run(0, { spendAmount: 4 })) !== 'complete')
      throw Error('Spend publication did not recover');

    // A disconnected wallet first sees only the obsolete token, then the deletion,
    // then the replacement without the deletion. These are real relay-side partitions.
    relayObjects.forEach((r) => r.control.setPartition({ eventIds: outboxIds }));
    const stale = await views();
    const staleOnlyObserved =
      stale.every(
        (v) => v.some((e) => e.id === original.id) && !v.some((e) => outboxIds.includes(e.id)),
      ) && (await sync(1)) === 'awaiting-peer';
    const staleBalance = read(1).summary.balance;
    const replacement = prepared.events.find((e) => e.kind === 7375)!;
    const deletion = prepared.events.find((e) => e.kind === 5)!;
    relayObjects.forEach((r) => r.control.setPartition({ eventIds: [replacement.id] }));
    const deleted = await views();
    const deletionFirstObserved =
      deleted.every(
        (v) => v.some((e) => e.id === deletion.id) && !v.some((e) => e.id === replacement.id),
      ) &&
      (await sync(1)) === 'awaiting-peer' &&
      read(1).summary.balance === 0;
    relayObjects.forEach((r) => r.control.setPartition({ eventIds: [deletion.id] }));
    relayObjects[1]!.control.setRule({ action: 'reorder_history', count: 2 });
    const replaced = await views();
    const replacementFirstObserved =
      replaced.every(
        (v) => v.some((e) => e.id === replacement.id) && !v.some((e) => e.id === deletion.id),
      ) && (await sync(1)) === 'complete';
    const reorderedHistoryObserved =
      relayObjects[1]!
        .snapshot()
        .rules.some((r) => r.action === 'reorder_history' && r.applied === 2) &&
      JSON.stringify(replaced[0]!.map((e) => e.id)) !==
        JSON.stringify(replaced[1]!.map((e) => e.id));
    relayObjects.forEach((r) => r.control.clearPartition());
    for (let i = 0; i < 2; i++) {
      if ((await sync(i)) !== 'complete') throw Error('Wallet failed to reconcile');
      // Re-delivery of the old nutzap must not restore its original balance.
      await run(i);
    }
    await Promise.all(relays.map((r) => publishEvent(r, original)));
    for (let i = 0; i < 2; i++)
      if ((await sync(i)) !== 'complete') throw Error('Stale-token replay changed balance');
    const after = [read(0), read(1)];
    const spend = after[0]!.record.spend!;
    const keep = after[0]!.record.wallet!.proofs;
    // A separate recipient actually redeems the transferred proofs at the mint.
    const recipient = await session.client();
    const payment = { ...zap, proofs: spend.sent, amount: spend.amount };
    const recipientPlan = await recipient.prepare(payment);
    const received = await recipient.swap(payment, recipientPlan);
    await recipient.verify(received);
    const finalViews = await views();
    const states = await Promise.all(
      [originalProofs, keep, spend.sent, received].map((p) => backend.states(p)),
    );
    evidence.postSpend = {
      amount: spend.amount,
      fee: spend.plan.fee,
      remaining: keep.reduce((n, p) => n + p.amount, 0),
      recipientAmount: received.reduce((n, p) => n + p.amount, 0),
      recipientFee: recipientPlan.fee,
      walletBalances: after.map((a) => a.summary.balance),
      credits: after.reduce((n, a) => n + a.summary.credits, 0),
      staleBalance,
      originalProofs: originalProofs.length,
      spentOriginalProofs: states[0]!.filter((s) => s === 'SPENT').length,
      changeProofs: keep.length,
      unspentChangeProofs: states[1]!.filter((s) => s === 'UNSPENT').length,
      sentProofs: spend.sent.length,
      spentSentProofs: states[2]!.filter((s) => s === 'SPENT').length,
      recipientProofs: received.length,
      unspentRecipientProofs: states[3]!.filter((s) => s === 'UNSPENT').length,
      staleOnlyObserved,
      deletionFirstObserved,
      replacementFirstObserved,
      reorderedHistoryObserved,
      retiredTokenRejected: after.every(
        (a) =>
          a.record.wallet?.token?.id === replacement.id &&
          a.record.wallet.retired.includes(original.id),
      ),
      publicationCrashObserved,
      outboxStable:
        JSON.stringify(outboxIds) === JSON.stringify(spend.events.map((e) => e.id)) &&
        relays.every((r) =>
          outboxIds.every((eid) => after[0]!.record.published.includes(JSON.stringify([r, eid]))),
        ),
      relayEventsAgree:
        finalViews.every((v) => outboxIds.every((eid) => v.some((e) => e.id === eid))) &&
        JSON.stringify(finalViews[0]!.map((e) => e.id).sort()) ===
          JSON.stringify(finalViews[1]!.map((e) => e.id).sort()),
    };
    if (native) {
      const files = await Promise.all(databases.map((path) => stat(path)));
      evidence.crossLanguage = {
        receivers: ['cashu-ts/4.7.2', 'cdk/0.17.3 + nostr/0.45.5'],
        cdkProcessObserved,
        crashedReceiver: crash ? (cdkIndex === 0 ? 'cdk' : 'cashu-ts') : 'none',
        privateJournals: files.every((f) => (f.mode & 0o777) === 0o600),
        postSpend: {
          spender: cdkIndex === 0 ? 'cdk' : 'cashu-ts',
          cdkSpendObserved,
          cdkSyncObserved,
          databasesDistinct: files[0]!.dev !== files[1]!.dev || files[0]!.ino !== files[1]!.ino,
        },
      };
    }
    const check = verifyNutzapEvidence(evidence, id);
    return {
      schemaVersion: 1,
      suite: 'nip61-recovery-v1',
      scenarioId: id,
      mode: mintUrl ? 'funded' : 'simulated',
      seedHash: digest(`nip61-recovery-seed-v1\0${seed}`),
      status: check.ok ? 'passed' : 'failed',
      evidence,
      failures: check.failures,
      fingerprint: evidenceFingerprint(evidence),
      implementations: {
        receiver: native
          ? 'cashu-fault-lab/cashu-ts + native-cdk-nip60-post-spend-v1'
          : 'cashu-fault-lab/nip60-post-spend-v1',
        mint: session.mintImplementation,
        relay: 'cashu-fault-lab/nostr-fault-relay',
      },
    };
  } finally {
    await session.close();
  }
}
