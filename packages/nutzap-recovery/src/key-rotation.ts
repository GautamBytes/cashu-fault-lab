import { join, isAbsolute } from 'node:path';
import { access, stat } from 'node:fs/promises';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools';
import { constants } from 'node:fs';
import { runCdkReceiver } from './cdk-process.js';
import type { WorkerInput } from './nutzap-worker.js';
import type { MintPort } from './types.js';
import { ReceivingKeys } from './receiving-keys.js';
import { createNutzapSession } from './session.js';
import { FundedMint } from './funded-mint.js';
import { SimulatedMint } from './simulated-mint.js';
import { Journal } from './journal.js';
import { runReceiverProcess } from './process.js';
import { publishEvent, queryEvents } from './relay.js';
import { digest, validateNutzap } from './protocol.js';
import { observeNutzap } from './observation.js';
import { evidenceFingerprint, verifyNutzapEvidence, type NutzapReport } from './evidence.js';

export async function runKeyRotationScenario(
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
  let keySelections = 0,
    blockedBeforeMint = 0,
    swaps = 0;
  const receive = (input: WorkerInput, backend: MintPort) =>
    native
      ? runCdkReceiver(binary!, input, '', async (phase) => {
          if (phase === 'receiving-key-selected') keySelections++;
          if (phase === 'missing-receiving-key') blockedBeforeMint++;
          if (phase === 'after-swap') swaps++;
          return phase === 'after-swap' && input.pauseAfterSwap ? 'kill' : 'continue';
        })
      : runReceiverProcess(input, backend, publishEvent);
  const session = await createNutzapSession(seed, mintUrl);
  const { directory, key, lock, info, event, relays, relayObjects, backend, zap } = session;
  const keyDatabase = join(directory, 'receiving-keys.sqlite');
  const senderDatabase = join(directory, 'sender-advertisements.sqlite');
  const database = join(directory, 'wallet.sqlite');
  const nextSecret = digest(`nip61-lab-rotated-lock\0${seed}`);
  const nextKey = Uint8Array.from(Buffer.from(nextSecret, 'hex'));
  const rotated = finalizeEvent(
    {
      ...info,
      created_at: info.created_at + 10,
      tags: info.tags.map((t) => (t[0] === 'pubkey' ? ['pubkey', getPublicKey(nextKey)] : t)),
    },
    key,
  );
  const missing = id.endsWith('missing-key');
  const crash = id.endsWith('crash-after-swap');
  const remember = (path: string, events: Event[], secret?: string) => {
    const keys = new ReceivingKeys(path, info.pubkey);
    try {
      events.forEach((e) => keys.remember(e, secret));
      return keys.current();
    } finally {
      keys.close();
    }
  };
  const read = () => {
    const db = new Journal(database);
    try {
      return { old: db.get(zap.id), summary: db.summary() };
    } finally {
      db.close();
    }
  };
  try {
    remember(keyDatabase, [info], missing ? undefined : Buffer.from(lock).toString('hex'));
    // Persist the new secret before advertising it. The old key is never overwritten.
    remember(keyDatabase, [rotated], nextSecret);
    remember(senderDatabase, [info]);
    await Promise.all(relays.map((r) => publishEvent(r, rotated)));
    relayObjects[0]!.control.setPartition({ eventIds: [event.id, info.id] });
    relayObjects[1]!.control.setPartition({ eventIds: [event.id, rotated.id] });
    const advertisements = await Promise.all(
      relays.map((r) => queryEvents(r, { kinds: [10019], authors: [info.pubkey] })),
    );
    const hidden = await Promise.all(
      relays.map((r) => queryEvents(r, { kinds: [9321], '#p': [info.pubkey] })),
    );
    const newer = remember(senderDatabase, advertisements[0]!);
    // Reopen the sender cache, then deliver the stale relay's answer.
    const selected = remember(senderDatabase, advertisements[1]!);
    const staleAdvertisementRejected =
      advertisements[0]!.some((e) => e.id === rotated.id) &&
      advertisements[1]!.length === 1 &&
      advertisements[1]![0]!.id === info.id &&
      newer.id === rotated.id &&
      selected.id === rotated.id;
    const delayedDeliveryObserved =
      hidden.every((events) => events.length === 0) &&
      (await backend.states(session.proofs)).every((s) => s === 'UNSPENT');
    relayObjects.forEach((r) => r.control.clearPartition());
    const inboxes = await Promise.all(
      relays.map((r) => queryEvents(r, { kinds: [9321], '#p': [info.pubkey] })),
    );
    if (inboxes.some((events) => events.length !== 1 || events[0]!.id !== event.id))
      throw Error('Delayed nutzap was not delivered');
    const input = {
      database,
      keyHex: Buffer.from(key).toString('hex'),
      info: rotated,
      event,
      relays,
      pauseAfterSwap: false,
      receivingKeys: { database: keyDatabase, funded: !!mintUrl },
    };
    let missingKeyBlocked = false,
      blockedWithoutCredit = false;
    if (missing) {
      missingKeyBlocked = (await receive(input, backend)) === 'recovery-blocked';
      const blocked = read();
      const views = await Promise.all(
        relays.map((r) => queryEvents(r, { kinds: [7375, 7376], authors: [info.pubkey] })),
      );
      blockedWithoutCredit =
        !blocked.old &&
        blocked.summary.credits === 0 &&
        blocked.summary.balance === 0 &&
        views.every((v) => v.length === 0) &&
        (await backend.states(session.proofs)).every((s) => s === 'UNSPENT');
      if (!missingKeyBlocked || !blockedWithoutCredit)
        throw Error('Missing receiving key did not block safely');
      remember(keyDatabase, [info], Buffer.from(lock).toString('hex'));
    }
    const first = await receive({ ...input, pauseAfterSwap: crash }, backend);
    const before = read();
    const killedAfterSwap =
      first === 'killed' &&
      before.summary.credits === 0 &&
      (await backend.states(session.proofs)).every((s) => s === 'SPENT');
    if (crash ? !killedAfterSwap : first !== 'complete')
      throw Error('Rotation recovery checkpoint failed');
    let completed = true;
    for (const inbox of inboxes)
      completed =
        (await receive({ ...input, event: inbox[0]! }, backend)) === 'complete' && completed;
    const old = read();
    if (!old.old) throw Error('Missing delayed nutzap journal');
    const evidence = await observeNutzap(
      session,
      old.old,
      old.summary,
      delayedDeliveryObserved,
      killedAfterSwap,
      completed,
    );

    // The sender uses its persisted advertisement, not the harness's expected key.
    const selectedLock = selected.tags.find((t) => t[0] === 'pubkey')![1]!;
    const nextBackend = mintUrl
      ? new FundedMint(mintUrl, nextSecret)
      : new SimulatedMint(selectedLock, `${seed}:rotated`);
    const proofs =
      nextBackend instanceof FundedMint
        ? await nextBackend.source(selectedLock)
        : nextBackend.source();
    const nextEvent = finalizeEvent(
      {
        ...event,
        created_at: rotated.created_at + 1,
        tags: [
          ...event.tags.filter((t) => t[0] !== 'proof'),
          ...proofs.map((p) => ['proof', JSON.stringify(p)]),
        ],
      },
      Uint8Array.from(Buffer.from(digest(`nip61-lab-sender\0${seed}`), 'hex')),
    );
    const nextZap = validateNutzap(nextEvent, selected);
    await Promise.all(relays.map((r) => publishEvent(r, nextEvent)));
    const newInboxes = await Promise.all(
      relays.map((r) => queryEvents(r, { kinds: [9321], ids: [nextEvent.id] })),
    );
    let newCompleted = newInboxes.every((v) => v.length === 1 && v[0]!.id === nextEvent.id);
    for (const inbox of newInboxes) {
      if (inbox[0])
        newCompleted =
          (await receive({ ...input, event: inbox[0] }, nextBackend)) === 'complete' &&
          newCompleted;
    }
    const db = new Journal(database);
    const nextRecord = db.get(nextZap.id);
    const total = db.summary();
    db.close();
    if (!nextRecord) throw Error('Missing rotated-key nutzap journal');
    const newPayment = await observeNutzap(
      { ...session, info: selected, event: nextEvent, zap: nextZap, backend: nextBackend, proofs },
      nextRecord,
      {
        credits: total.credits - old.summary.credits,
        balance: total.balance - old.summary.balance,
      },
      newInboxes.every((v) => v.length === 1),
      false,
      newCompleted,
      old.old.events.map((e) => e.id),
    );
    // Retry both payments again after reopening all private state.
    for (const [payment, client] of [
      [event, backend],
      [nextEvent, nextBackend],
    ] as const)
      if ((await receive({ ...input, event: payment }, client)) !== 'complete')
        throw Error('Duplicate delivery failed');
    const finalDb = new Journal(database);
    const finalSummary = finalDb.summary();
    const finalOld = finalDb.get(zap.id)!;
    const finalNew = finalDb.get(nextZap.id)!;
    finalDb.close();
    const views = await Promise.all(
      relays.map((r) => queryEvents(r, { kinds: [7375, 7376], authors: [info.pubkey] })),
    );
    const ids = [...old.old.events, ...nextRecord.events].map((e) => e.id).sort();
    const finalKeys = new ReceivingKeys(keyDatabase, info.pubkey);
    let oldKeyRecovered = false;
    try {
      oldKeyRecovered =
        finalKeys.current().id === rotated.id &&
        finalOld.zap.lockingKey === getPublicKey(lock) &&
        finalKeys.entries().some((e) => e.secret === Buffer.from(lock).toString('hex'));
    } finally {
      finalKeys.close();
    }
    evidence.rotation = {
      ...(native ? { native: { keySelections, blockedBeforeMint, swaps } } : {}),
      staleAdvertisementRejected,
      delayedDeliveryObserved,
      oldKeyRecovered,
      newKeyUsed:
        nextZap.lockingKey === getPublicKey(nextKey) && nextZap.lockingKey !== zap.lockingKey,
      missingKeyBlocked,
      blockedWithoutCredit,
      newPayment,
      privateState: (
        await Promise.all([keyDatabase, senderDatabase, database].map((p) => stat(p)))
      ).every((s) => (s.mode & 0o777) === 0o600),
      totalCredits: finalSummary.credits,
      totalBalance: finalSummary.balance,
      oldOutputsStillUnspent: (await backend.states(finalOld.wallet!.proofs)).every(
        (s) => s === 'UNSPENT',
      ),
      duplicateStable:
        JSON.stringify(total) === JSON.stringify(finalSummary) &&
        JSON.stringify([...finalOld.events, ...finalNew.events].map((e) => e.id).sort()) ===
          JSON.stringify(ids) &&
        views.every((v) => JSON.stringify(v.map((e) => e.id).sort()) === JSON.stringify(ids)),
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
        receiver: native ? 'cdk/0.17.3 + nostr/0.45.5' : 'cashu-fault-lab/nip61-key-rotation-v1',
        mint: session.mintImplementation,
        relay: 'cashu-fault-lab/nostr-fault-relay',
      },
    };
  } finally {
    await session.close();
  }
}
