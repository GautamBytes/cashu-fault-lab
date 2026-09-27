import { join, isAbsolute } from 'node:path';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { snapshot } from './cdk.js';
import { runCdkReceiver } from './cdk-process.js';
import type { WorkerInput } from './nutzap-worker.js';
import type { MintPort } from './types.js';
import { createNutzapSession } from './session.js';
import { runReceiverProcess } from './process.js';
import { publishEvent, queryEvents } from './relay.js';
import { observeNutzap } from './observation.js';
import { digest } from './protocol.js';
import { evidenceFingerprint, verifyNutzapEvidence, type NutzapReport } from './evidence.js';

/** Two durable spend intents over the same inputs, with a reproducible mint winner. */
export async function runConcurrentSpendScenario(
  id: string,
  seed: string,
  mintUrl?: string,
  binary?: string,
): Promise<NutzapReport> {
  const native = id.startsWith('cdk-');
  if (native) {
    if (!mintUrl || !binary || !isAbsolute(binary))
      throw Error('CDK scenarios require a disposable mint URL and receiver binary');
    await access(binary, constants.X_OK);
  }
  const winner = native && !id.startsWith('cdk-peer-') ? 1 : 0;
  const loser = 1 - winner;
  const crash = id.endsWith('crash-after-swap');
  const session = await createNutzapSession(seed, mintUrl);
  const { directory, key, info, event, zap, relays, relayObjects, backend } = session;
  try {
    const databases = ['spender-a.sqlite', 'spender-b.sqlite'].map((n) => join(directory, n));
    const amounts = [4, 5];
    const clients = await Promise.all([session.client(), session.client()]);
    const inputs: WorkerInput[] = databases.map((database) => ({
      database,
      keyHex: Buffer.from(key).toString('hex'),
      info,
      event,
      relays,
      pauseAfterSwap: false,
      syncPeers: true,
    }));
    const read = (i: number) => snapshot(databases[i]!, zap.id);
    const ready = Promise.withResolvers<void>();
    const swapped = Promise.withResolvers<void>();
    const attempts = new Set<number>();
    let racing = false,
      successfulSwaps = 0,
      nativeObserved = false,
      nativeSync = false;
    const gate = async (i: number) => {
      attempts.add(i);
      if (attempts.size === 2) ready.resolve();
      await ready.promise;
      if (i !== winner) await swapped.promise;
    };
    const run = (i: number, extra: Partial<WorkerInput> = {}) => {
      const input = { ...inputs[i]!, ...extra };
      if (native && i === 1)
        return runCdkReceiver(
          binary!,
          input,
          Buffer.from(session.lock).toString('hex'),
          async (phase) => {
            nativeObserved = true;
            if (phase === 'after-wallet-sync') nativeSync = true;
            if (racing && phase === 'spend-before-swap') await gate(i);
            if (racing && phase === 'spend-after-swap') {
              successfulSwaps++;
              swapped.resolve();
            }
            return phase === 'spend-after-swap' && input.pauseAfterSwap ? 'kill' : 'continue';
          },
        );
      const client = clients[i]!;
      const mint: MintPort = {
        prepare: (z) => client.prepare(z),
        prepareSpend: (p, a) => client.prepareSpend!(p, a),
        restore: (z, p) => client.restore(z, p),
        states: (p) => client.states(p),
        verify: (p) => client.verify(p),
        swap: async (z, p) => {
          if (racing) await gate(i);
          const result = await client.swap(z, p);
          if (racing) {
            successfulSwaps++;
            swapped.resolve();
          }
          return result;
        },
      };
      return runReceiverProcess(input, mint, publishEvent);
    };
    for (let i = 0; i < 2; i++)
      if ((await run(i)) !== 'complete') throw Error('Initial wallet sync failed');
    const initial = read(0);
    const originalProofs = initial.record.wallet!.proofs;
    const original = initial.record.wallet!.token!;
    const evidence = await observeNutzap(
      session,
      initial.record,
      initial.summary,
      true,
      false,
      true,
    );
    // Withhold every new wallet event while both devices still see the initial receipt.
    relayObjects.forEach((r) => r.control.setPartition({ kinds: [7375, 7376, 5] }));
    racing = true;
    const first = await Promise.allSettled(
      [0, 1].map((i) =>
        run(i, {
          spendAmount: amounts[i]!,
          pauseAfterSwap: crash && i === winner,
        }).catch((error: unknown) => {
          ready.resolve();
          swapped.resolve();
          throw error;
        }),
      ),
    );
    racing = false;
    const results = first.map((r) => {
      if (r.status === 'rejected') throw r.reason;
      return r.value;
    });
    const before = [read(0), read(1)];
    const crashObserved =
      results[winner] === 'killed' &&
      before[winner]!.record.spend!.events.length === 0 &&
      (await backend.states(originalProofs)).every((s) => s === 'SPENT');
    if (
      results[loser] !== 'recovery-blocked' ||
      (crash ? !crashObserved : results[winner] !== 'complete')
    )
      throw Error('Concurrent spend fault was not exercised');
    // Restart both SDK instances and every receiver process before attempting recovery.
    clients[0] = await session.client();
    clients[1] = await session.client();
    if (
      crash &&
      ((await run(winner, { syncWallet: true })) !== 'awaiting-peer' ||
        read(winner).summary.balance !== 0)
    )
      throw Error('Own recoverable outputs must remain reserved');
    const blocked = await run(loser, { syncWallet: true });
    const partitionBalance = read(loser).summary.balance;
    if ((await run(winner, { spendAmount: amounts[winner]! })) !== 'complete')
      throw Error('Winner failed to restore its saved payment');
    const winnerBefore = read(winner).record.spend!;
    const partitioned = await Promise.all(
      relays.map((r) => queryEvents(r, { kinds: [7375, 7376, 5] })),
    );
    relayObjects.forEach((r) => r.control.clearPartition());
    for (let i = 0; i < 2; i++)
      if ((await run(i, { syncWallet: true })) !== 'complete')
        throw Error('Spend conflict did not reconcile');
    const retries = await Promise.all([0, 1].map((i) => run(i, { spendAmount: amounts[i]! })));
    // Replay the old token and original nutzap after the conflict was persisted.
    await Promise.all(relays.map((r) => publishEvent(r, original)));
    for (let i = 0; i < 2; i++) {
      await run(i);
      if ((await run(i, { syncWallet: true })) !== 'complete')
        throw Error('Replay resurrected old balance');
    }
    const after = [read(0), read(1)];
    const spend = after[winner]!.record.spend!;
    const losingSpend = after[loser]!.record.spend!;
    const keep = after[winner]!.record.wallet!.proofs;
    // Separate recipient clients: only proofs from a completed intent can be delivered.
    const recipientBalances = [0, 0];
    const recipientFees = [0, 0];
    const received = [];
    for (let i = 0; i < 2; i++) {
      const transfer = after[i]!.record.spend!;
      if (!transfer.sent.length) continue;
      const recipient = await session.client();
      const payment = { ...zap, proofs: transfer.sent, amount: transfer.amount };
      const plan = await recipient.prepare(payment);
      const proofs = await recipient.swap(payment, plan);
      await recipient.verify(proofs);
      recipientBalances[i] = proofs.reduce((n, p) => n + p.amount, 0);
      recipientFees[i] = plan.fee;
      received.push(...proofs);
    }
    const states = await Promise.all(
      [originalProofs, keep, spend.sent, received].map((p) => backend.states(p)),
    );
    const files = await Promise.all(databases.map((p) => stat(p)));
    const outbox = spend.events.map((e) => e.id);
    const views = await Promise.all(
      relays.map((r) => queryEvents(r, { kinds: [7375, 7376, 5], authors: [info.pubkey] })),
    );
    evidence.concurrentSpend = {
      winner,
      intents: amounts,
      swapAttempts: attempts.size,
      successfulSwaps,
      databasesDistinct: files[0]!.ino !== files[1]!.ino || files[0]!.dev !== files[1]!.dev,
      plansDistinct: before[0]!.record.spend!.plan.outputs.every(
        (p) => !before[1]!.record.spend!.plan.outputs.some((q) => q.secret === p.secret),
      ),
      partitionObserved: partitioned.every((v) => v.length === 0) && blocked === 'awaiting-peer',
      partitionBalance,
      crashObserved,
      results: retries,
      loserHasNoPayment:
        losingSpend.conflicted === true && !losingSpend.sent.length && !losingSpend.events.length,
      plansStable: after.every(
        (a, i) =>
          JSON.stringify(a.record.spend!.plan) === JSON.stringify(before[i]!.record.spend!.plan),
      ),
      amount: spend.amount,
      fee: spend.plan.fee,
      remaining: keep.reduce((n, p) => n + p.amount, 0),
      recipientBalances,
      recipientFees,
      walletBalances: after.map((a) => a.summary.balance),
      credits: after.reduce((n, a) => n + a.summary.credits, 0),
      proofCounts: [originalProofs, keep, spend.sent, received].map((p) => p.length),
      stateCounts: states.map(
        (s, i) => s.filter((v) => v === (i === 0 || i === 2 ? 'SPENT' : 'UNSPENT')).length,
      ),
      retiredTokenRejected: after.every(
        (a) =>
          a.record.wallet!.retired.includes(original.id) &&
          a.record.wallet!.token?.id === after[winner]!.record.wallet!.token?.id,
      ),
      outboxStable:
        JSON.stringify(outbox) === JSON.stringify(winnerBefore.events.map((e) => e.id)) &&
        relays.every((r) =>
          outbox.every((eid) => after[winner]!.record.published.includes(JSON.stringify([r, eid]))),
        ),
      relayEventsAgree:
        views.every((v) => outbox.every((eid) => v.some((e) => e.id === eid))) &&
        JSON.stringify(views[0]!.map((e) => e.id).sort()) ===
          JSON.stringify(views[1]!.map((e) => e.id).sort()),
      nativeSyncObserved: nativeSync,
    };
    if (native)
      evidence.crossLanguage = {
        receivers: ['cashu-ts/4.7.2', 'cdk/0.17.3 + nostr/0.45.5'],
        cdkProcessObserved: nativeObserved,
        crashedReceiver: crash ? (winner === 1 ? 'cdk' : 'cashu-ts') : 'none',
        privateJournals: files.every((f) => (f.mode & 0o777) === 0o600),
      };
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
          ? 'cashu-fault-lab/cashu-ts + native-cdk-concurrent-spend-v1'
          : 'cashu-fault-lab/nip60-concurrent-spend-v1',
        mint: session.mintImplementation,
        relay: 'cashu-fault-lab/nostr-fault-relay',
      },
    };
  } finally {
    await session.close();
  }
}
