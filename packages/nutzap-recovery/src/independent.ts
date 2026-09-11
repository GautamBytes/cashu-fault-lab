import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { NostrFaultRelay } from '@cashu-fault-lab/nostr-fault-relay';
import { createNutzapSession } from './session.js';
import { Journal } from './journal.js';
import { runReceiverProcess } from './process.js';
import { publishEvent, queryEvents } from './relay.js';
import { observeNutzap } from './observation.js';
import { digest } from './protocol.js';
import { evidenceFingerprint, verifyNutzapEvidence, type NutzapReport } from './evidence.js';
import type { MintPort, ReceiveResult } from './types.js';

export async function runIndependentScenario(
  id: string,
  seed: string,
  mintUrl?: string,
): Promise<NutzapReport> {
  const session = await createNutzapSession(seed, mintUrl);
  const { directory, relays, relayObjects, event, info, key, zap, proofs } = session;
  try {
    const databases = [join(directory, 'wallet-a.sqlite'), join(directory, 'wallet-b.sqlite')];
    databases.forEach((path) => new Journal(path).close());
    const files = await Promise.all(databases.map((path) => stat(path)));
    const clients = await Promise.all([session.client(), session.client()]);
    let swaps = 0,
      successes = 0;
    let releaseSwaps!: () => void;
    const swapBarrier = new Promise<void>((resolve) => {
      releaseSwaps = resolve;
    });
    let releasePublication!: () => void;
    const publicationBarrier = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const ports: MintPort[] = clients.map((_client, i) => ({
      prepare: (zap) => clients[i]!.prepare(zap),
      restore: (zap, plan) => clients[i]!.restore(zap, plan),
      states: (proofs) => clients[i]!.states(proofs),
      verify: (proofs) => clients[i]!.verify(proofs),
      swap: async (zap, plan) => {
        swaps++;
        if (swaps === 2) releaseSwaps();
        await swapBarrier;
        const outputs = await clients[i]!.swap(zap, plan);
        successes++;
        return outputs;
      },
    }));
    const inputs = databases.map((database) => ({
      database,
      keyHex: Buffer.from(key).toString('hex'),
      info,
      event,
      relays,
      pauseAfterSwap: false,
      syncPeers: true,
    }));
    const snapshot = () =>
      databases.map((path) => {
        const db = new Journal(path);
        try {
          return { record: db.get(zap.id), summary: db.summary() };
        } finally {
          db.close();
        }
      });
    const outage = id === 'independent-relay-outage';
    let relayOutageObserved = false;
    if (outage) {
      await Promise.all(relayObjects.map((r) => r.close()));
      const probes = await Promise.allSettled(relays.map((r) => queryEvents(r, { kinds: [7376] })));
      relayOutageObserved = probes.every((p) => p.status === 'rejected');
    }
    let awaitingPeerObserved = false;
    const first = await Promise.allSettled(
      inputs.map((input, i) =>
        runReceiverProcess(
          { ...input, pauseAfterSwap: id === 'independent-crash-after-swap' },
          ports[i]!,
          async (relay, event) => {
            await publicationBarrier;
            await publishEvent(relay, event);
          },
        ).then((result) => {
          if (result === 'awaiting-peer') {
            awaitingPeerObserved = true;
            releasePublication();
          }
          return result;
        }),
      ),
    );
    releasePublication();
    const results = first.map((r) => {
      if (r.status === 'rejected') throw Error('Independent receiver failed');
      return r.value;
    });
    const before = snapshot();
    const plansDistinct =
      !!before[0]?.record &&
      !!before[1]?.record &&
      before[0].record.plan.material !== before[1].record.plan.material &&
      before[0].record.plan.outputs.every((a) =>
        before[1]!.record!.plan.outputs.every((b) => a.secret !== b.secret),
      );
    const killedIndex = results.indexOf('killed');
    const killedAfterSwap =
      killedIndex >= 0 &&
      before.every((v) => v.summary.credits === 0) &&
      (await session.backend.states(proofs)).every((s) => s === 'SPENT');
    if (killedIndex >= 0) clients[killedIndex] = await session.client();
    if (outage) {
      relayOutageObserved =
        relayOutageObserved && results.includes('publication-pending') && awaitingPeerObserved;
      for (let i = 0; i < relays.length; i++) {
        relayObjects[i] = new NostrFaultRelay();
        await relayObjects[i]!.listen(Number(new URL(relays[i]!).port));
      }
    }
    let final: ReceiveResult[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      final = [];
      for (let i = 0; i < inputs.length; i++) {
        const result = await runReceiverProcess(inputs[i]!, ports[i]!, publishEvent);
        if (result === 'killed') throw Error('Unexpected independent receiver termination');
        final.push(result);
      }
      if (final.every((r) => r === 'complete')) break;
    }
    const after = snapshot();
    const winner = after.find((v) => v.record?.credit !== null && v.record?.origin === 'local');
    if (!winner?.record) throw Error('No independently settled nutzap');
    const evidence = await observeNutzap(
      session,
      winner.record,
      {
        credits: after.reduce((sum, v) => sum + v.summary.credits, 0),
        balance: winner.summary.balance,
      },
      swaps === 2 && awaitingPeerObserved && (!outage || relayOutageObserved),
      killedAfterSwap,
      final.every((r) => r === 'complete'),
    );
    evidence.independent = {
      databasesDistinct: files[0]!.dev !== files[1]!.dev || files[0]!.ino !== files[1]!.ino,
      plansDistinct,
      swapAttempts: swaps,
      successfulSwaps: successes,
      localCredits: after.map((v) => v.summary.credits).sort(),
      replicatedWallets: after.filter(
        (v) => v.record?.origin === 'relay' && v.record.credit !== null,
      ).length,
      walletBalances: after.map((v) => v.summary.balance).sort((a, b) => a - b),
      walletEventsAgree: after.every(
        (v) =>
          JSON.stringify(v.record?.events.map((e) => e.id).sort()) ===
          JSON.stringify(winner.record!.events.map((e) => e.id).sort()),
      ),
      awaitingPeerObserved,
      relayOutageObserved,
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
        receiver: 'cashu-fault-lab/nip61-independent-journals-v1',
        mint: mintUrl ? 'cashu-ts/4.7.2 + operator-provided loopback mint' : 'simulated-mint/v1',
        relay: 'cashu-fault-lab/nostr-fault-relay',
      },
    };
  } finally {
    await session.close();
  }
}
