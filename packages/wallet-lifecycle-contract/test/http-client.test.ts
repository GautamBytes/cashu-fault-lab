import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import {
  HttpLifecycleAdapterClient,
  LifecycleAdapterClientError,
  type LifecycleCapabilities,
  type LifecycleOperationView,
} from '../src/index.js';

const listeners: Array<ReturnType<typeof createServer>> = [];
const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  listeners.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('fixture address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    listeners
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const operation: LifecycleOperationView = {
  operationId,
  kind: 'mint',
  mint: 'http://127.0.0.1:3338',
  unit: 'sat',
  intentHash: 'a'.repeat(64),
  phase: 'created',
  amount: 64,
};

describe('HTTP lifecycle adapter client', () => {
  test('uses authenticated lifecycle routes and validates responses', async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      authorization: string | undefined;
    }> = [];
    const baseUrl = await fixture((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === `/v1/lifecycle/operations/${operationId}`) {
        response.end(JSON.stringify(operation));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    const client = new HttpLifecycleAdapterClient({ baseUrl, token: 'control-token' });

    await client.reset('seed-1');
    await expect(client.operation(operationId)).resolves.toEqual(operation);
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/v1/lifecycle/reset',
        authorization: 'Bearer control-token',
      },
      {
        method: 'GET',
        url: `/v1/lifecycle/operations/${operationId}`,
        authorization: 'Bearer control-token',
      },
    ]);
  });

  test('sends resume as a bodyless path operation', async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      authorization: string | undefined;
      contentType: string | undefined;
      body: string;
    }> = [];
    const baseUrl = await fixture((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk as Buffer));
      request.on('end', () => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(operation));
      });
    });
    const client = new HttpLifecycleAdapterClient({ baseUrl, token: 'control-token' });

    await expect(client.resume(operationId)).resolves.toEqual(operation);
    expect(requests).toEqual([
      {
        method: 'POST',
        url: `/v1/lifecycle/operations/${operationId}/resume`,
        authorization: 'Bearer control-token',
        contentType: undefined,
        body: '',
      },
    ]);
  });

  test('forbids redirects without forwarding the bearer token', async () => {
    let leaked = false;
    const target = await fixture((request, response) => {
      leaked ||= request.headers.authorization !== undefined;
      response.end('{}');
    });
    const baseUrl = await fixture((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', target);
      response.end('{}');
    });
    const client = new HttpLifecycleAdapterClient({ baseUrl, token: 'control-token' });

    await expect(client.operation(operationId)).rejects.toMatchObject({
      code: 'LIFECYCLE_ADAPTER_REDIRECT',
    });
    expect(leaked).toBe(false);
  });

  test('bounds response bodies and sanitizes dependency errors', async () => {
    const baseUrl = await fixture((_request, response) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 'MINT_FAILED', secret: 'do-not-leak' }));
    });
    const client = new HttpLifecycleAdapterClient({ baseUrl, token: 'control-token' });

    await expect(client.operation(operationId)).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleAdapterClientError>>({
        code: 'LIFECYCLE_ADAPTER_HTTP_STATUS',
        message: 'Lifecycle adapter returned HTTP status 500 (MINT_FAILED)',
      }),
    );
  });

  test('rejects malformed successful responses', async () => {
    const baseUrl = await fixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ...operation, quoteId: 'secret' }));
    });
    const client = new HttpLifecycleAdapterClient({ baseUrl, token: 'control-token' });

    await expect(client.operation(operationId)).rejects.toMatchObject({
      code: 'LIFECYCLE_ADAPTER_CONTRACT',
    });
  });

  test('validates constructor secrets and origins', () => {
    for (const baseUrl of [
      'not-a-url',
      'http://user:pass@127.0.0.1:4101',
      'file:///tmp/x',
      'https://adapter.example.com',
      'http://localhost:4101',
    ]) {
      expect(() => new HttpLifecycleAdapterClient({ baseUrl, token: 'token' })).toThrow('base URL');
    }
    expect(
      () => new HttpLifecycleAdapterClient({ baseUrl: 'http://[::1]:4101', token: 'token' }),
    ).not.toThrow();
    expect(
      () => new HttpLifecycleAdapterClient({ baseUrl: 'http://127.0.0.1:4101', token: '' }),
    ).toThrow('control token');
  });
});

void ({} as LifecycleCapabilities);
