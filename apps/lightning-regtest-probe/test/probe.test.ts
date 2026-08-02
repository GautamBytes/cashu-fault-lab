import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LightningRegtestProbe } from '../src/index.js';

const servers: Array<{ close(callback: (error?: Error) => void): void }> = [];

async function mockLnd(network = 'regtest'): Promise<string> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/getinfo') {
      response.end(JSON.stringify({ chains: [{ chain: 'bitcoin', network }] }));
    } else if (request.url?.startsWith('/v1/payreq/') === true) {
      response.end(JSON.stringify({ payment_hash: 'a'.repeat(64) }));
    } else if (request.url === `/v1/invoice/${'a'.repeat(64)}`) {
      response.end(JSON.stringify({ state: 'SETTLED', settled: true }));
    } else {
      response.writeHead(404).end('{}');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('mock LND did not bind');
  return `http://127.0.0.1:${address.port}/`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

describe('Lightning regtest probe', () => {
  it('accepts only a Bitcoin regtest node and independently queries invoice settlement', async () => {
    const probe = new LightningRegtestProbe({
      host: '127.0.0.1',
      port: 4400,
      token: 'regtest-probe-token',
      lndUrl: await mockLnd(),
    });
    await probe.assertRegtest();
    expect(await probe.settled('lnbcrt1independent-settlement')).toBe(true);
  });

  it('rejects non-regtest nodes, external cleartext URLs, and short credentials', async () => {
    const probe = new LightningRegtestProbe({
      host: '127.0.0.1',
      port: 4400,
      token: 'regtest-probe-token',
      lndUrl: await mockLnd('mainnet'),
    });
    await expect(probe.assertRegtest()).rejects.toThrow(/non-regtest/u);
    expect(
      () =>
        new LightningRegtestProbe({
          host: '127.0.0.1',
          port: 4400,
          token: 'regtest-probe-token',
          lndUrl: 'http://example.com/',
        }),
    ).toThrow(/LND URL/u);
    expect(
      () =>
        new LightningRegtestProbe({
          host: '127.0.0.1',
          port: 4400,
          token: 'short',
          lndUrl: 'http://127.0.0.1:8080/',
        }),
    ).toThrow(/token/u);
  });
});
