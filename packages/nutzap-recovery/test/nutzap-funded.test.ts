import { describe, expect, it } from 'vitest';
import {
  runNutzapScenario,
  SCENARIOS,
  CDK_SCENARIOS,
  verifyNutzapEvidence,
} from '../src/runner.js';
import { FundedMint } from '../src/funded-mint.js';
import { replayNutzapReport } from '../src/replay.js';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { join } from 'node:path';
import { createNutzapSession } from '../src/session.js';
import { runCdkReceiver } from '../src/cdk-process.js';
import type { Nutzap } from '../src/protocol.js';
describe('funded NIP-61 recovery', () => {
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
  it.each(CDK_SCENARIOS)(
    '%s: native CDK and cashu-ts recover through signed relay events',
    async (id) => {
      const mintUrl = process.env.CFL_NUTZAP_MINT_URL;
      const cdkReceiver = process.env.CFL_NUTZAP_CDK_RECEIVER;
      if (!mintUrl || !cdkReceiver) throw Error('Run pnpm test:nutzap:funded');
      const options = { mintUrl, cdkReceiver };
      const result = await runNutzapScenario(id, 'funded-native-cdk', options);
      expect(result.mode).toBe('funded');
      expect(result.status, JSON.stringify(result)).toBe('passed');
      expect(result.evidence.crossLanguage?.cdkProcessObserved).toBe(true);
      expect(result.evidence.independent?.localCredits).toEqual([0, 1]);
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
      if (id !== 'cdk-concurrent') {
        expect(result.evidence.killedAfterSwap).toBe(true);
        expect(verifyNutzapEvidence({ ...result.evidence, killedAfterSwap: false }, id).ok).toBe(
          false,
        );
      }
      const replay = await replayNutzapReport(result, 'funded-native-cdk', options);
      expect(replay.status).toBe('passed');
      expect(replay.fingerprint).toBe(result.fingerprint);
    },
    120_000,
  );
  it.each(SCENARIOS)(
    '%s: real P2PK swap, restore and mint state evidence',
    async (id) => {
      const mintUrl = process.env.CFL_NUTZAP_MINT_URL;
      if (!mintUrl) throw Error('Run pnpm test:nutzap:funded with a disposable mint');
      const result = await runNutzapScenario(id, 'funded-nip61', { mintUrl });
      expect(result.mode).toBe('funded');
      expect(result.status, JSON.stringify(result)).toBe('passed');
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
  it.each(['crash-after-swap', 'independent-crash-after-swap'])(
    'replays funded %s evidence with fresh proofs',
    async (scenario) => {
      const mintUrl = process.env.CFL_NUTZAP_MINT_URL;
      if (!mintUrl) throw Error('Run pnpm test:nutzap:funded with a disposable mint');
      const report = await runNutzapScenario(scenario, 'funded-replay', { mintUrl });
      const replay = await replayNutzapReport(report, 'funded-replay', { mintUrl });
      expect(replay.status).toBe('passed');
      expect(replay.fingerprint).toBe(report.fingerprint);
    },
    90_000,
  );
});
