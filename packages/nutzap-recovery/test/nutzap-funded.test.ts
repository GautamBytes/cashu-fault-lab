import { describe, expect, it } from 'vitest';
import { runNutzapScenario, SCENARIOS } from '../src/runner.js';
import { FundedMint } from '../src/funded-mint.js';
import { replayNutzapReport } from '../src/replay.js';
import { getPublicKey } from 'nostr-tools';
import type { Nutzap } from '../src/protocol.js';
describe('funded NIP-61 recovery', () => {
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
