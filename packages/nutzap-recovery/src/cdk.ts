import { join, isAbsolute } from 'node:path';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createNutzapSession } from './session.js';
import { Journal } from './journal.js';
import { runReceiverProcess } from './process.js';
import { runCdkReceiver } from './cdk-process.js';
import { publishEvent } from './relay.js';
import { observeNutzap } from './observation.js';
import { digest } from './protocol.js';
import { evidenceFingerprint, verifyNutzapEvidence, type NutzapReport } from './evidence.js';
import type { MintPort, RedemptionRecord } from './types.js';

function snapshot(path: string, id: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT record FROM redemptions WHERE id=?').get(id);
    if (!row) throw Error('Missing cross-language journal record');
    const record: RedemptionRecord = JSON.parse(String(row.record));
    const records: RedemptionRecord[] = db
      .prepare('SELECT record FROM redemptions')
      .all()
      .map((r) => JSON.parse(String(r.record)));
    return {
      record,
      summary: {
        credits: records.filter((r) => r.credit !== null && r.origin !== 'relay').length,
        balance: records.reduce((n, r) => n + (r.credit ?? 0), 0),
      },
    };
  } finally {
    db.close();
  }
}
function signal() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

export async function runCdkScenario(
  id: string,
  seed: string,
  mintUrl?: string,
  binary?: string,
): Promise<NutzapReport> {
  if (!mintUrl || !binary)
    throw Error('CDK scenarios require a disposable mint URL and receiver binary');
  if (!isAbsolute(binary)) throw Error('CDK receiver binary must be an absolute executable path');
  await access(binary, constants.X_OK);
  const session = await createNutzapSession(seed, mintUrl);
  try {
    const { directory, key, lock, info, event, relays, zap, proofs } = session;
    const databases = [join(directory, 'cashu-ts.sqlite'), join(directory, 'cdk.sqlite')];
    new Journal(databases[0]!).close();
    let client = await session.client();
    const ready = signal(),
      swapped = signal(),
      published = signal();
    const preferred =
      id === 'cdk-crash-after-swap' ? 1 : id === 'cdk-peer-crash-after-swap' ? 0 : undefined;
    let attempts = 0,
      successes = 0,
      awaitingPeerObserved = false,
      cdkCheckpoints = 0;
    const gate = async (index: number) => {
      if (++attempts === 2) ready.release();
      await ready.promise;
      if (preferred !== undefined && preferred !== index) await swapped.promise;
    };
    const port: MintPort = {
      prepare: (z) => client.prepare(z),
      restore: (z, p) => client.restore(z, p),
      states: (p) => client.states(p),
      verify: (p) => client.verify(p),
      swap: async (z, p) => {
        await gate(0);
        const outputs = await client.swap(z, p);
        successes++;
        swapped.release();
        return outputs;
      },
    };
    const inputs = databases.map((database) => ({
      database,
      keyHex: Buffer.from(key).toString('hex'),
      info,
      event,
      relays,
      pauseAfterSwap: false,
      syncPeers: true,
    }));
    const run = (index: number, first: boolean) =>
      index === 0
        ? runReceiverProcess(
            { ...inputs[0]!, pauseAfterSwap: first && preferred === 0 },
            port,
            async (r, e) => {
              if (first) await published.promise;
              await publishEvent(r, e);
            },
          )
        : runCdkReceiver(binary, inputs[1]!, Buffer.from(lock).toString('hex'), async (phase) => {
            cdkCheckpoints++;
            if (phase === 'before-swap') await gate(1);
            if (phase === 'after-swap') {
              successes++;
              swapped.release();
              if (first && preferred === 1) return 'kill';
            }
            if (phase === 'before-publish' && first) await published.promise;
            return 'continue';
          });
    const first = await Promise.allSettled(
      [0, 1].map((i) =>
        run(i, true)
          .then((r) => {
            if (r === 'awaiting-peer') {
              awaitingPeerObserved = true;
              published.release();
            }
            return r;
          })
          .catch((error: unknown) => {
            ready.release();
            swapped.release();
            published.release();
            throw error;
          }),
      ),
    );
    published.release();
    const results = first.map((r) => {
      if (r.status === 'rejected') throw r.reason;
      return r.value;
    });
    const before = databases.map((p) => snapshot(p, zap.id));
    const killedIndex = results.indexOf('killed');
    const killedAfterSwap =
      killedIndex >= 0 &&
      killedIndex === preferred &&
      before.every((v) => v.summary.credits === 0) &&
      (await session.backend.states(proofs)).every((s) => s === 'SPENT');
    if (killedIndex === 0) client = await session.client();
    let completed = false;
    for (let retry = 0; retry < 4; retry++) {
      const states = [await run(0, false), await run(1, false)];
      completed = states.every((s) => s === 'complete');
      if (completed) break;
    }
    const after = databases.map((p) => snapshot(p, zap.id));
    const files = await Promise.all(databases.map((p) => stat(p)));
    const winner = after.find((v) => v.record.origin === 'local' && v.record.credit !== null);
    if (!winner) throw Error('Cross-language redemption did not settle');
    const evidence = await observeNutzap(
      session,
      winner.record,
      {
        credits: after.reduce((sum, v) => sum + v.summary.credits, 0),
        balance: winner.summary.balance,
      },
      attempts === 2 && awaitingPeerObserved,
      killedAfterSwap,
      completed,
    );
    evidence.independent = {
      databasesDistinct: files[0]!.dev !== files[1]!.dev || files[0]!.ino !== files[1]!.ino,
      plansDistinct:
        before[0]!.record.plan.material !== before[1]!.record.plan.material &&
        before[0]!.record.plan.outputs.every((a) =>
          before[1]!.record.plan.outputs.every((b) => a.secret !== b.secret),
        ),
      swapAttempts: attempts,
      successfulSwaps: successes,
      localCredits: after.map((v) => v.summary.credits).sort(),
      replicatedWallets: after.filter(
        (v) => v.record.origin === 'relay' && v.record.credit !== null,
      ).length,
      walletBalances: after.map((v) => v.summary.balance).sort((a, b) => a - b),
      walletEventsAgree: after.every(
        (v) =>
          JSON.stringify(v.record.events.map((e) => e.id).sort()) ===
          JSON.stringify(winner.record.events.map((e) => e.id).sort()),
      ),
      awaitingPeerObserved,
      relayOutageObserved: false,
    };
    evidence.crossLanguage = {
      receivers: ['cashu-ts/4.7.2', 'cdk/0.17.3 + nostr/0.45.5'],
      cdkProcessObserved: cdkCheckpoints > 0,
      crashedReceiver: killedIndex < 0 ? 'none' : killedIndex === 0 ? 'cashu-ts' : 'cdk',
      privateJournals: files.every((f) => (f.mode & 0o777) === 0o600),
    };
    const check = verifyNutzapEvidence(evidence, id);
    return {
      schemaVersion: 1,
      suite: 'nip61-recovery-v1',
      scenarioId: id,
      mode: 'funded',
      seedHash: digest(`nip61-recovery-seed-v1\0${seed}`),
      status: check.ok ? 'passed' : 'failed',
      evidence,
      failures: check.failures,
      fingerprint: evidenceFingerprint(evidence),
      implementations: {
        receiver: 'cashu-fault-lab/cashu-ts + native-cdk-nip61-v1',
        mint: 'operator-provided loopback mint',
        relay: 'cashu-fault-lab/nostr-fault-relay',
      },
    };
  } finally {
    await session.close();
  }
}
