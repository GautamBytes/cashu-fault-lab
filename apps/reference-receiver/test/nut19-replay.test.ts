import { afterEach, describe, expect, it } from 'vitest';
import { CashuTsMintGateway } from '../src/index.js';
import { MockMintServer } from './mock-mint.js';
import { draftForMockMint } from './recovery-test-fixture.js';

const servers: MockMintServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe('NUT-19 interrupted swap recovery', () => {
  it('prefers NUT-09 output restoration over dispatching a NUT-19 replay', async () => {
    const mint = new MockMintServer({ nut09: true, nut19Ttl: 300 });
    servers.push(mint);
    await mint.start();
    const gateway = new CashuTsMintGateway({ now: () => 1_784_399_400 });
    const plan = await gateway.prepareSwap(draftForMockMint(mint.url));
    mint.dropNextSwapResponse = true;
    await expect(gateway.swap(plan)).rejects.toMatchObject({ mayHaveConsumedInputs: true });

    const recovered = await gateway.restore(plan);

    expect(recovered.kind).toBe('recovered');
    expect(mint.swapCalls).toBe(1);
    expect(mint.restoreCalls).toBe(1);
  });

  it('reports every dispatched NUT-19 replay when NUT-09 is unavailable', async () => {
    let now = 1_784_399_400;
    const mint = new MockMintServer({ nut09: false, nut19Ttl: 300 });
    servers.push(mint);
    await mint.start();
    const gateway = new CashuTsMintGateway({ now: () => now });
    const plan = await gateway.prepareSwap(draftForMockMint(mint.url));
    mint.dropNextSwapResponse = true;
    await expect(gateway.swap(plan)).rejects.toMatchObject({ mayHaveConsumedInputs: true });
    let dispatchedReplays = 0;

    const recovered = await gateway.restore(plan, {
      afterRequestDispatched: async () => {
        dispatchedReplays += 1;
      },
    });

    expect(recovered.kind).toBe('recovered');
    expect(mint.swapCalls).toBe(2);
    expect(mint.swapBodies[1]).toBe(mint.swapBodies[0]);
    expect(dispatchedReplays).toBe(1);

    now += 301;
    await expect(gateway.restore(plan)).resolves.toEqual({ kind: 'not_found' });
  });
});
