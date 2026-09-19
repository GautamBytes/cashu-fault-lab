import { join } from 'node:path';
import { runKeyRotationScenario } from './key-rotation.js';
import { digest } from './protocol.js';
import { Journal } from './journal.js';
import { publishEvent } from './relay.js';
import { runReceiverProcess } from './process.js';
import { evidenceFingerprint, verifyNutzapEvidence, type NutzapReport } from './evidence.js';
import type { MintPort } from './types.js';
import { createNutzapSession } from './session.js';
import { observeNutzap } from './observation.js';
import { runIndependentScenario } from './independent.js';
import { runCdkScenario } from './cdk.js';
import { runPostSpendScenario } from './post-spend.js';
export { verifyNutzapEvidence } from './evidence.js';
export const SCENARIOS = [
  'duplicate-relays',
  'concurrent-redemption',
  'crash-after-swap',
  'swap-response-lost',
  'publish-response-lost',
  'independent-concurrent',
  'independent-crash-after-swap',
  'independent-relay-outage',
  'post-spend-stale-relay',
  'post-spend-publication-crash',
  'key-rotation-delayed',
  'key-rotation-crash-after-swap',
  'key-rotation-missing-key',
] as const;
export const CDK_SCENARIOS = [
  'cdk-concurrent',
  'cdk-crash-after-swap',
  'cdk-peer-crash-after-swap',
  'cdk-post-spend-stale-relay',
  'cdk-post-spend-publication-crash',
  'cdk-peer-post-spend-stale-relay',
  'cdk-peer-post-spend-publication-crash',
] as const;
export interface NutzapRunOptions {
  mintUrl?: string;
  cdkReceiver?: string;
}
export function validateRun(id: string, seed: string): void {
  if (![...SCENARIOS, ...CDK_SCENARIOS].some((s) => s === id))
    throw Error('Unknown NIP-61 recovery scenario');
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 256)
    throw Error('Nutzap seed must contain 1-256 characters');
}
export async function runNutzapScenario(
  id: string,
  seed: string,
  options: NutzapRunOptions = {},
): Promise<NutzapReport> {
  validateRun(id, seed);
  if (id.startsWith('key-rotation-')) return runKeyRotationScenario(id, seed, options.mintUrl);
  if (id.includes('post-spend-'))
    return runPostSpendScenario(id, seed, options.mintUrl, options.cdkReceiver);
  if (id.startsWith('cdk-')) return runCdkScenario(id, seed, options.mintUrl, options.cdkReceiver);
  if (id.startsWith('independent-')) return runIndependentScenario(id, seed, options.mintUrl);
  const session = await createNutzapSession(seed, options.mintUrl);
  const { key, backend, proofs, directory, relayObjects, relays, info, event, zap, inboxes } =
    session;
  try {
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
      verify: (p) => backend.verify(p),
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
    const evidence = await observeNutzap(
      session,
      record,
      summary,
      observed,
      killedAfterSwap,
      completed,
    );
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
        mint: session.mintImplementation,
        relay: 'cashu-fault-lab/nostr-fault-relay',
      },
    };
  } finally {
    await session.close();
  }
}
