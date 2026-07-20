import { describe, expect, it } from 'vitest';
import { FundedCashuTsWallet } from '../src/funded-wallet.js';

const mintUrl = process.env.CFL_REAL_MINT_URL;

describe.skipIf(!mintUrl)('funded cashu-ts Docker mint adapter', () => {
  it('funds and reserves real proofs without exposing proof material', async () => {
    const wallet = new FundedCashuTsWallet({
      mintUrl: mintUrl!,
      fundingAmount: 8,
    });
    await wallet.reset('docker-funded-wallet');
    const reserved = await wallet.reserve(8, 'sat', [mintUrl!], 'EBESExQVFhcYGRobHB0eHw');
    const evidence = await wallet.evidence('EBESExQVFhcYGRobHB0eHw');

    expect(reserved.proofs).not.toHaveLength(0);
    expect(evidence).toMatchObject({ state: 'pending' });
    expect(JSON.stringify(evidence)).not.toContain(reserved.proofs[0]!.secret);
  }, 60_000);
});
