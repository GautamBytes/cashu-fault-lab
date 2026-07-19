import { afterEach, describe, expect, it } from 'vitest';
import { CashuTsMintGateway } from '../src/index.js';
import { MockMintServer } from './mock-mint.js';
import { draftForMockMint } from './recovery-test-fixture.js';

const servers: MockMintServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe('NUT-19 interrupted swap recovery', () => {
  it('replays byte-identical swap requests only inside the advertised TTL', async () => {
    let now = 1_784_399_400;
    const mint = new MockMintServer({ nut09: true, nut19Ttl: 300 });
    servers.push(mint);
    await mint.start();
    const gateway = new CashuTsMintGateway({ now: () => now });
    const plan = await gateway.prepareSwap(draftForMockMint(mint.url));
    mint.dropNextSwapResponse = true;
    await expect(gateway.swap(plan)).rejects.toMatchObject({ mayHaveConsumedInputs: true });

    const recovered = await gateway.restore(plan);

    expect(recovered.kind).toBe('recovered');
    expect(mint.swapCalls).toBe(2);
    expect(mint.swapBodies[1]).toBe(mint.swapBodies[0]);
    expect(mint.restoreCalls).toBe(0);

    now += 301;
    const afterTtl = await gateway.restore(plan);
    expect(afterTtl.kind).toBe('recovered');
    expect(mint.restoreCalls).toBe(1);
  });
});
