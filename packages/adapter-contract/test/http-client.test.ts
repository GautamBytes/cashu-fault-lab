import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterClientError, AdapterNotApplicableError, HttpAdapterClient } from '../src/index.js';

interface FixtureVector {
  readonly receipt: unknown;
}

const receipt = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../spec/vectors/delivery-v1-wire.json', import.meta.url)),
      'utf8',
    ),
  ) as { readonly vectors: readonly FixtureVector[] }
).vectors[0]!.receipt;

const capabilities = {
  implementation: 'fixture-wallet',
  version: '1.0.0',
  nuts: [18],
  transports: ['http'],
  evidenceTier: 'T1',
  encodings: ['creqA'],
  profiles: [{ name: 'delivery-v1', roles: ['sender'], status: 'supported' }],
} as const;

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

describe('HttpAdapterClient', () => {
  it('authenticates and validates adapter requests and responses', async () => {
    const requests: Array<{ method: string; url: string; authorization?: string; body: string }> =
      [];
    const baseUrl = await serve((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body,
        });
        if (request.url === '/v1/capabilities') return json(response, 200, capabilities);
        if (request.url === '/v1/reset') return json(response, 200, { ok: true });
        if (request.url === '/v1/send') return json(response, 200, receipt);
        response.writeHead(404).end();
      });
    });
    const client = new HttpAdapterClient({ baseUrl, token: 'control-token' });

    await expect(client.capabilities()).resolves.toEqual(capabilities);
    await expect(client.reset('seed-a')).resolves.toBeUndefined();
    await expect(client.send({ request: 'creqAexample' })).resolves.toEqual(
      expect.objectContaining({
        status: 'processing',
        delivery_id: 'EBESExQVFhcYGRobHB0eHw',
      }),
    );

    expect(requests).toEqual([
      {
        method: 'GET',
        url: '/v1/capabilities',
        authorization: 'Bearer control-token',
        body: '',
      },
      {
        method: 'POST',
        url: '/v1/reset',
        authorization: 'Bearer control-token',
        body: '{"seed":"seed-a"}',
      },
      {
        method: 'POST',
        url: '/v1/send',
        authorization: 'Bearer control-token',
        body: '{"request":"creqAexample"}',
      },
    ]);
  });

  it('rejects redirects without forwarding the control token', async () => {
    let redirectedAuthorization: string | undefined;
    const targetUrl = await serve((request, response) => {
      redirectedAuthorization = request.headers.authorization;
      json(response, 200, capabilities);
    });
    const baseUrl = await serve((_request, response) => {
      response.writeHead(302, { location: `${targetUrl}/v1/capabilities` }).end();
    });
    const client = new HttpAdapterClient({ baseUrl, token: 'control-token' });

    await expect(client.capabilities()).rejects.toMatchObject({ code: 'ADAPTER_REDIRECT' });
    expect(redirectedAuthorization).toBeUndefined();
  });

  it('rejects contract-invalid and oversized responses with stable errors', async () => {
    const invalidUrl = await serve((_request, response) => json(response, 200, { extra: true }));
    await expect(
      new HttpAdapterClient({ baseUrl: invalidUrl, token: 'token' }).capabilities(),
    ).rejects.toMatchObject({ code: 'ADAPTER_CONTRACT' });

    const oversizedUrl = await serve((_request, response) => {
      json(response, 200, { value: 'x'.repeat(1_000) });
    });
    await expect(
      new HttpAdapterClient({
        baseUrl: oversizedUrl,
        token: 'token',
        maxResponseBytes: 100,
      }).capabilities(),
    ).rejects.toMatchObject({ code: 'ADAPTER_RESPONSE_TOO_LARGE' });
  });

  it('maps explicit unsupported operations to AdapterNotApplicableError', async () => {
    const baseUrl = await serve((_request, response) => {
      json(response, 501, { status: 'N/A', reason: 'Receiver ledger is unavailable' });
    });
    const client = new HttpAdapterClient({ baseUrl, token: 'token' });

    const error = await client.ledger().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdapterNotApplicableError);
    expect(error).toMatchObject({
      code: 'ADAPTER_NOT_APPLICABLE',
      reason: 'Receiver ledger is unavailable',
    });
  });

  it('includes safe adapter error codes without exposing error bodies', async () => {
    const baseUrl = await serve((_request, response) => {
      json(response, 422, {
        code: 'SEND_FAILED',
        message: 'raw wallet proof secret',
      });
    });
    const client = new HttpAdapterClient({ baseUrl, token: 'token' });

    const error = await client.send({ request: 'creqAexample' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdapterClientError);
    expect(error).toMatchObject({ code: 'ADAPTER_HTTP_STATUS' });
    expect(String(error)).toContain('SEND_FAILED');
    expect(String(error)).not.toContain('raw wallet proof secret');
  });

  it('times out without exposing dependency errors', async () => {
    const baseUrl = await serve(() => {});
    const client = new HttpAdapterClient({ baseUrl, token: 'token', timeoutMs: 20 });

    const error = await client.capabilities().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdapterClientError);
    expect(error).toMatchObject({ code: 'ADAPTER_TIMEOUT' });
    expect(String(error)).not.toMatch(/AbortError|control-token/);
  });
});
