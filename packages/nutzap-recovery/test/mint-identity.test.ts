import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { readMintImplementation } from '../src/funded-mint.js';
import { replayNutzapReport } from '../src/replay.js';
import { runNutzapScenario } from '../src/runner.js';

async function withMint(
  version: unknown,
  check: (url: string, requests: string[]) => Promise<void>,
) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version, nuts: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing server address');
  try {
    await check(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('observed mint implementation', () => {
  it.each(['Nutshell/0.20.2', 'cdk-mintd/0.17.3'])(
    'reads %s without mutating the mint',
    async (version) => {
      await withMint(version, async (url, requests) => {
        expect(await readMintImplementation(url)).toBe(version);
        expect(requests).toEqual(['GET /v1/info']);
      });
    },
  );
  it.each([
    undefined,
    42,
    '',
    'unknown',
    'name/1.0\nsecret',
    'name/1.0\n',
    'name/' + 'a'.repeat(200),
  ])('rejects malformed mint identity %s', async (version) => {
    await withMint(version, async (url) => {
      await expect(readMintImplementation(url)).rejects.toThrow('Invalid mint implementation');
    });
  });
  // This case starts real relays and receiver processes, like the runner/replay tests.
  it('rejects a replay against a different mint implementation before creating proofs', async () => {
    const original = await runNutzapScenario('duplicate-relays', 'identity-replay');
    await withMint('cdk-mintd/0.17.3', async (url, requests) => {
      await expect(
        replayNutzapReport(
          {
            ...original,
            mode: 'funded',
            implementations: { ...original.implementations, mint: 'Nutshell/0.20.2' },
          },
          'identity-replay',
          { mintUrl: url },
        ),
      ).rejects.toThrow('mint implementation mismatch');
      expect(requests).toEqual(['GET /v1/info']);
    });
  }, 30_000);
});
