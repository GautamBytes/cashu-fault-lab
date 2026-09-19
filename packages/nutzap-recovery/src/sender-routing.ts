import { join } from 'node:path';
import { finalizeEvent } from 'nostr-tools';
import { NostrFaultRelay } from '@cashu-fault-lab/nostr-fault-relay';
import { createNutzapSession } from './session.js';
import { Journal } from './journal.js';
import { discoverSenderRelays } from './sender-relays.js';
import { publishEvent, queryEvents } from './relay.js';
import { runReceiverProcess } from './process.js';
import { observeNutzap } from './observation.js';
import { digest } from './protocol.js';
import { evidenceFingerprint, verifyNutzapEvidence, type NutzapReport } from './evidence.js';

export async function runSenderRoutingScenario(
  id: string,
  seed: string,
  mintUrl?: string,
): Promise<NutzapReport> {
  const session = await createNutzapSession(seed, mintUrl);
  const destinations = [new NostrFaultRelay(), new NostrFaultRelay(), new NostrFaultRelay()];
  try {
    const urls = await Promise.all(destinations.map((r) => r.listen()));
    const senderKey = Uint8Array.from(Buffer.from(digest(`nip61-lab-sender\0${seed}`), 'hex'));
    const older = finalizeEvent(
      { kind: 10002, created_at: 1700000000, content: '', tags: [['r', urls[2]!]] },
      senderKey,
    );
    const newer = finalizeEvent(
      {
        kind: 10002,
        created_at: 1700000010,
        content: '',
        tags: [
          ['r', urls[0]!, 'read'],
          ['r', urls[1]!],
          ['r', urls[2]!, 'write'],
        ],
      },
      senderKey,
    );
    await publishEvent(session.relays[0]!, newer);
    await publishEvent(session.relays[1]!, older);
    const database = join(session.directory, 'wallet.sqlite');
    const db = new Journal(database);
    try {
      // Populate from real REQs, then reopen in a worker with only stale relay answers.
      if (id === 'sender-relay-stale-list') {
        await discoverSenderRelays(db, session.event.pubkey, session.relays, queryEvents);
        session.relayObjects[0]!.control.setPartition({ eventIds: [newer.id] });
      }
    } finally {
      db.close();
    }
    let offlineObserved = false;
    if (id === 'sender-relay-outage') {
      await destinations[0]!.close();
      const probe = await Promise.allSettled([queryEvents(urls[0]!, { kinds: [7376] })]);
      offlineObserved = probe[0]!.status === 'rejected';
    }
    if (id === 'sender-relay-response-lost')
      destinations[0]!.control.setRule({
        action: 'drop_ok',
        count: 1,
        kind: 7376,
      });
    const input = {
      database,
      keyHex: Buffer.from(session.key).toString('hex'),
      info: session.info,
      event: session.event,
      relays: session.relays,
      pauseAfterSwap: false,
      discoverSenderRelays: true,
    };
    const first = await runReceiverProcess(input, session.backend, publishEvent);
    const before = new Journal(database);
    let saved: string[];
    let staleListRejected: boolean;
    try {
      saved = before.get(session.zap.id)!.events.map((e) => e.id);
      staleListRejected = before.relayList(session.event.pubkey)?.id === newer.id;
    } finally {
      before.close();
    }
    const faultObserved =
      id === 'sender-relay-stale-list'
        ? (await queryEvents(session.relays[0]!, { kinds: [10002] })).length === 0 &&
          staleListRejected
        : first === 'publication-pending' &&
          (id === 'sender-relay-outage'
            ? offlineObserved
            : destinations[0]!.snapshot().rules.some((r) => r.applied === 1));
    if (id === 'sender-relay-outage') {
      destinations[0] = new NostrFaultRelay();
      await destinations[0].listen(Number(new URL(urls[0]!).port));
    }
    // Discovery can now be unavailable; the committed destination snapshot must suffice.
    session.relayObjects.forEach((r) => r.control.setPartition({ kinds: [10002] }));
    const recovered = await runReceiverProcess(input, session.backend, publishEvent);
    const duplicate = await runReceiverProcess(input, session.backend, publishEvent);
    const final = new Journal(database);
    try {
      const record = final.get(session.zap.id)!;
      const evidence = await observeNutzap(
        session,
        record,
        final.summary(),
        faultObserved,
        false,
        recovered === 'complete' && duplicate === 'complete',
      );
      const views = await Promise.all(
        urls.map((r) => queryEvents(r, { kinds: [7375, 7376], authors: [session.info.pubkey] })),
      );
      const history = record.events.find((e) => e.kind === 7376)!;
      evidence.senderRelays = {
        staleListRejected,
        offlineObserved,
        historyCounts: views.slice(0, 2).map((v) => v.filter((e) => e.kind === 7376).length),
        tokenCounts: views.slice(0, 2).map((v) => v.filter((e) => e.kind === 7375).length),
        writeOnlyEvents: views[2]!.length,
        outboxStable:
          JSON.stringify(record.events.map((e) => e.id)) === JSON.stringify(saved) &&
          views.slice(0, 2).every((v) => v.length === 1 && v[0]!.id === history.id),
        pendingObserved: first === 'publication-pending',
      };
      const check = verifyNutzapEvidence(evidence, id);
      return {
        schemaVersion: 1,
        suite: 'nip61-recovery-v1',
        scenarioId: id,
        seedHash: digest(`nip61-recovery-seed-v1\0${seed}`),
        mode: mintUrl ? 'funded' : 'simulated',
        status: check.ok ? 'passed' : 'failed',
        evidence,
        failures: check.failures,
        fingerprint: evidenceFingerprint(evidence),
        implementations: {
          receiver: 'cashu-fault-lab/nip65-sender-routing-v1',
          mint: session.mintImplementation,
          relay: 'cashu-fault-lab/nostr-fault-relay',
        },
      };
    } finally {
      final.close();
    }
  } finally {
    await Promise.allSettled(destinations.map((r) => r.close()));
    await session.close();
  }
}
