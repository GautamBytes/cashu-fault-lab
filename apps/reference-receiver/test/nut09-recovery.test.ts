import { afterEach, describe, expect, it } from 'vitest';
import { CashuTsMintGateway, MintGatewayError } from '../src/index.js';
import { MockMintServer } from './mock-mint.js';
import { draftForMockMint } from './recovery-test-fixture.js';

const servers: MockMintServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe('NUT-09 interrupted swap recovery', () => {
  it('restores the same outputs after a committed response is lost', async () => {
    const mint = new MockMintServer({ nut09: true, nut19Ttl: null });
    servers.push(mint);
    await mint.start();
    const gateway = new CashuTsMintGateway({ now: () => 1_784_399_400 });
    const plan = await gateway.prepareSwap(draftForMockMint(mint.url));
    mint.dropNextSwapResponse = true;

    await expect(gateway.swap(plan)).rejects.toMatchObject({
      name: MintGatewayError.name,
      mayHaveConsumedInputs: true,
    });
    const recovered = await gateway.restore(plan);

    expect(recovered.kind).toBe('recovered');
    expect(mint.swapCalls).toBe(1);
    expect(mint.restoreCalls).toBe(1);
  });
});
