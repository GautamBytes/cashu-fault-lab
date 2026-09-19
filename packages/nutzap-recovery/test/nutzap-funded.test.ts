import { beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import {
  runNutzapScenario,
  SCENARIOS,
  CDK_SCENARIOS,
  verifyNutzapEvidence,
} from '../src/runner.js';
import { FundedMint, readMintImplementation } from '../src/funded-mint.js';
import type { NutzapReport } from '../src/evidence.js';
import { replayNutzapReport } from '../src/replay.js';
import { finalizeEvent, getPublicKey, nip44 } from 'nostr-tools';
import { runReceiverProcess } from '../src/process.js';
import { publishEvent } from '../src/relay.js';
import { snapshot } from '../src/cdk.js';
import { join } from 'node:path';
import { createNutzapSession } from '../src/session.js';
import { runCdkReceiver } from '../src/cdk-process.js';
import type { Nutzap } from '../src/protocol.js';
describe('funded NIP-61 recovery', () => {
  const expectedMint = process.env.CFL_NUTZAP_EXPECTED_MINT;
  beforeAll(async () => {
    const mintUrl = process.env.CFL_NUTZAP_MINT_URL;
    if (!mintUrl || !expectedMint) throw Error('Run pnpm test:nutzap:funded');
    expect(await readMintImplementation(mintUrl)).toBe(expectedMint);
  });
  async function retain(report: NutzapReport) {
    expect(report.implementations.mint).toBe(expectedMint);
    const directory = process.env.CFL_NUTZAP_REPORT_DIR;
    if (directory)
      await writeFile(
        join(directory, `${report.scenarioId}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
        { mode: 0o600 },
      );
  }

  it('native CDK rejects forged DLEQ before any swap checkpoint or source spend', async () => {
    const mintUrl = process.env.CFL_NUTZAP_MINT_URL;
    const binary = process.env.CFL_NUTZAP_CDK_RECEIVER;
    if (!mintUrl || !binary) throw Error('Run pnpm test:nutzap:funded');
    const session = await createNutzapSession('native-invalid-dleq', mintUrl);
    try {
      const event = finalizeEvent(
        {
          ...session.event,
          tags: session.event.tags.map((t) => {
            if (t[0] !== 'proof') return t;
            const proof = JSON.parse(t[1]!);
            proof.dleq.e = '11'.repeat(32);
            return ['proof', JSON.stringify(proof)];
          }),
        },
        session.lock,
      );
      let checkpoints = 0;
      await expect(
        runCdkReceiver(
          binary,
          {
            database: join(session.directory, 'rejected.sqlite'),
            keyHex: Buffer.from(session.key).toString('hex'),
            info: session.info,
            event,
            relays: session.relays,
            pauseAfterSwap: false,
          },
          Buffer.from(session.lock).toString('hex'),
          async () => {
            checkpoints++;
            return 'continue';
          },
        ),
      ).rejects.toThrow('invalid_dleq');
      expect(checkpoints).toBe(0);
      expect(await session.backend.states(session.proofs)).toEqual(
        session.proofs.map(() => 'UNSPENT'),
      );
    } finally {
      await session.close();
    }
  }, 90_000);
  it('native post-spend sync rejects forged DLEQ and conflicting signed replacements', async () => {
    const mintUrl = process.env.CFL_NUTZAP_MINT_URL;
    const binary = process.env.CFL_NUTZAP_CDK_RECEIVER;
    if (!mintUrl || !binary) throw Error('Run pnpm test:nutzap:funded');
    const session = await createNutzapSession('native-post-spend-canary', mintUrl);
    try {
      const input = {
        database: join(session.directory, 'spender.sqlite'),
        keyHex: Buffer.from(session.key).toString('hex'),
        info: session.info,
        event: session.event,
        relays: session.relays,
        pauseAfterSwap: false,
      };
      const reader = { ...input, database: join(session.directory, 'reader.sqlite') };
      const native = (syncWallet = false) =>
        runCdkReceiver(
          binary,
          { ...reader, syncWallet },
          Buffer.from(session.lock).toString('hex'),
          async () => 'continue',
        );
      const client = await session.client();
      expect(await runReceiverProcess(input, client, publishEvent)).toBe('complete');
      expect(await native()).toBe('complete');
      expect(await runReceiverProcess({ ...input, spendAmount: 4 }, client, publishEvent)).toBe(
        'complete',
      );
      const spent = snapshot(input.database, session.zap.id).record;
      const replacement = spent.spend!.events.find((e) => e.kind === 7375)!;
      const conversation = nip44.v2.utils.getConversationKey(session.key, session.info.pubkey);
      const body = JSON.parse(nip44.v2.decrypt(replacement.content, conversation));
      const forged = structuredClone(body);
      forged.proofs[0].dleq.e = '11'.repeat(32);
      const sign = (payload: unknown) =>
        finalizeEvent(
          {
            kind: 7375,
            created_at: replacement.created_at + 1,
            tags: [],
            content: nip44.v2.encrypt(JSON.stringify(payload), conversation),
          },
          session.key,
        );
      const invalid = sign(forged);
      const duplicate = sign(body);
      await Promise.all(session.relays.map((r) => publishEvent(r, invalid)));
      session.relayObjects.forEach((r) => r.control.setPartition({ eventIds: [replacement.id] }));
      expect(await native(true)).toBe('awaiting-peer');
      expect(snapshot(reader.database, session.zap.id).summary.balance).toBe(0);
      // Even two individually valid replacements cannot establish a unique transition.
      session.relayObjects.forEach((r) => r.control.clearPartition());
      await Promise.all(session.relays.map((r) => publishEvent(r, duplicate)));
      expect(await native(true)).toBe('awaiting-peer');
      expect(snapshot(reader.database, session.zap.id).summary.balance).toBe(0);
      session.relayObjects.forEach((r) => r.control.setPartition({ eventIds: [duplicate.id] }));
      expect(await native(true)).toBe('complete');
      const restored = snapshot(reader.database, session.zap.id);
      expect(restored.summary.balance).toBe(spent.wallet!.proofs.reduce((n, p) => n + p.amount, 0));
      expect(restored.record.credit).toBe(spent.credit);
      expect(restored.summary.credits).toBe(0);
    } finally {
      await session.close();
    }
  }, 90_000);
  it.each(CDK_SCENARIOS)(
    '%s: native CDK and cashu-ts recover through signed relay events',
    async (id) => {
      const mintUrl = process.env.CFL_NUTZAP_MINT_URL;
      const cdkReceiver = process.env.CFL_NUTZAP_CDK_RECEIVER;
      if (!mintUrl || !cdkReceiver) throw Error('Run pnpm test:nutzap:funded');
      const options = { mintUrl, cdkReceiver };
      const result = await runNutzapScenario(id, 'funded-native-cdk', options);
      expect(result.implementations.mint).toBe(expectedMint);
      expect(result.mode).toBe('funded');
      expect(result.status, JSON.stringify(result)).toBe('passed');
      expect(result.evidence.crossLanguage?.cdkProcessObserved).toBe(true);
      if (id.includes('post-spend-')) {
        expect(result.evidence.postSpend?.credits).toBe(1);
        expect(result.evidence.crossLanguage?.postSpend?.cdkSyncObserved).toBe(true);
        for (const patch of [
          { cdkSyncObserved: false },
          { cdkSpendObserved: id.startsWith('cdk-peer-') },
          { databasesDistinct: false },
        ]) {
          expect(
            verifyNutzapEvidence(
              {
                ...result.evidence,
                crossLanguage: {
                  ...result.evidence.crossLanguage!,
                  postSpend: { ...result.evidence.crossLanguage!.postSpend!, ...patch },
                },
              },
              id,
            ).ok,
          ).toBe(false);
        }
        for (const patch of [
          { credits: 2 },
          { staleBalance: 1 },
          { retiredTokenRejected: false },
          { outboxStable: false },
          { walletBalances: [999, 999] },
          { publicationCrashObserved: !id.endsWith('publication-crash') },
        ]) {
          expect(
            verifyNutzapEvidence(
              { ...result.evidence, postSpend: { ...result.evidence.postSpend!, ...patch } },
              id,
            ).ok,
          ).toBe(false);
        }
      } else expect(result.evidence.independent?.localCredits).toEqual([0, 1]);
      for (const patch of [
        { cdkProcessObserved: false },
        { privateJournals: false },
        { receivers: ['cashu-ts/4.7.2', 'cashu-ts/4.7.2'] },
      ]) {
        expect(
          verifyNutzapEvidence(
            { ...result.evidence, crossLanguage: { ...result.evidence.crossLanguage!, ...patch } },
            id,
          ).ok,
        ).toBe(false);
      }
      if (id !== 'cdk-concurrent' && !id.includes('post-spend-')) {
        expect(result.evidence.killedAfterSwap).toBe(true);
        expect(verifyNutzapEvidence({ ...result.evidence, killedAfterSwap: false }, id).ok).toBe(
          false,
        );
      }
      const replay = await replayNutzapReport(result, 'funded-native-cdk', options);
      expect(replay.status).toBe('passed');
      expect(replay.fingerprint).toBe(result.fingerprint);
      await retain(result);
    },
    120_000,
  );
  it.each(SCENARIOS)(
    '%s: real P2PK swap, restore and mint state evidence',
    async (id) => {
      const mintUrl = process.env.CFL_NUTZAP_MINT_URL;
      if (!mintUrl) throw Error('Run pnpm test:nutzap:funded with a disposable mint');
      const result = await runNutzapScenario(id, 'funded-nip61', { mintUrl });
      expect(result.implementations.mint).toBe(expectedMint);
      expect(result.mode).toBe('funded');
      expect(result.status, JSON.stringify(result)).toBe('passed');
      const replay = await replayNutzapReport(result, 'funded-nip61', { mintUrl });
      expect(replay.fingerprint).toBe(result.fingerprint);
      await retain(result);
    },
    90_000,
  );
  it('rejects invalid input DLEQ without spending real mint proofs', async () => {
    const mintUrl = process.env.CFL_NUTZAP_MINT_URL;
    if (!mintUrl) throw Error('Run pnpm test:nutzap:funded with a disposable mint');
    const key = Uint8Array.from([...Array(31).fill(0), 7]);
    const mint = new FundedMint(mintUrl, Buffer.from(key).toString('hex'));
    const proofs = await mint.source(getPublicKey(key));
    // prepare only consumes the validated proof list; signature validation has its own tests.
    const zap = {
      proofs: proofs.map((p) => ({ ...p, dleq: { ...p.dleq!, e: '00'.repeat(32) } })),
    } as Nutzap;
    await expect(mint.prepare(zap)).rejects.toThrow();
    await expect(mint.verify(proofs)).resolves.toBeUndefined();
    await expect(mint.verify(zap.proofs)).rejects.toThrow();
    expect(await mint.states(proofs)).toEqual(proofs.map(() => 'UNSPENT'));
    expect(mint.successfulSwaps).toBe(0);
  }, 90_000);
});
