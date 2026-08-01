import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayEvidence } from '../src/control.js';
import { HttpFaultGateway } from '../src/proxy.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

describe('HttpFaultGateway', () => {
  let downstream: Server | undefined;
  let downstreamUrl: string;
  let gateway: HttpFaultGateway | undefined;
  let gatewayUrl: string;
  let bodies: Buffer[];
  let slowResponseBody: boolean;
  let finishedResponses: number;

  beforeEach(async () => {
    bodies = [];
    slowResponseBody = false;
    finishedResponses = 0;
    downstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks));
        response.writeHead(200, { 'content-type': 'application/json' });
        if (slowResponseBody) {
          response.flushHeaders();
          setTimeout(() => {
            finishedResponses += 1;
            response.end(JSON.stringify({ accepted: true, ordinal: bodies.length }));
          }, 100);
        } else {
          finishedResponses += 1;
          response.end(JSON.stringify({ accepted: true, ordinal: bodies.length }));
        }
      });
    });
    downstreamUrl = await listen(downstream);
    gateway = new HttpFaultGateway({ downstream: downstreamUrl });
    gatewayUrl = await gateway.listen();
  });

  afterEach(async () => {
    await gateway?.close();
    if (downstream?.listening) {
      await new Promise<void>((resolve, reject) =>
        downstream!.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  async function post(
    body = '{"delivery":{"id":"EBESExQVFhcYGRobHB0eHw"}}',
    path = '/pay',
    operationId?: string,
  ) {
    return fetch(`${gatewayUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(operationId === undefined ? {} : { 'x-cashu-fault-operation-id': operationId }),
      },
      body,
    });
  }

  it('matches a Cashu endpoint family and operation without persisting either secret', async () => {
    gateway!.control.setRule({
      phase: 'after_downstream_response',
      action: 'drop',
      count: 1,
      match: { endpointFamily: 'mint', operationId: 'AAAAAAAAAAAAAAAAAAAAAA' },
    });

    await expect(
      post('{"quote":"credential","outputs":[]}', '/v1/mint/bolt11', 'AAAAAAAAAAAAAAAAAAAAAA'),
    ).rejects.toThrowError(/fetch|socket|terminated/i);
    expect(bodies).toHaveLength(1);

    const evidence = gateway!.control.snapshot();
    expect(evidence.rules[0]).toMatchObject({ endpointFamily: 'mint', applied: 1 });
    expect(evidence.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/mint/bolt11',
      endpointFamily: 'mint',
      attemptOrdinal: 1,
      bodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(evidence)).not.toContain('AAAAAAAAAAAAAAAAAAAAAA');
    expect(JSON.stringify(evidence)).not.toContain('credential');
  });

  it('returns a bounded stale quote response after forwarding the fresh poll', async () => {
    const first = await post('{}', '/v1/mint/quote/bolt11/quote-id', 'AAAAAAAAAAAAAAAAAAAAAA');
    expect(await first.json()).toMatchObject({ ordinal: 1 });
    gateway!.control.setRule({
      phase: 'after_downstream_response',
      action: 'stale_response',
      count: 1,
      match: { endpointFamily: 'quote', operationId: 'AAAAAAAAAAAAAAAAAAAAAA' },
    });

    const stale = await post('{}', '/v1/mint/quote/bolt11/quote-id', 'AAAAAAAAAAAAAAAAAAAAAA');
    expect(await stale.json()).toMatchObject({ ordinal: 1 });
    expect(bodies).toHaveLength(2);
  });

  it('does not reuse stale responses across a control reset', async () => {
    await post('{}', '/v1/mint/quote/bolt11/quote-id', 'AAAAAAAAAAAAAAAAAAAAAA');
    gateway!.control.reset();
    gateway!.control.setRule({
      phase: 'after_downstream_response',
      action: 'stale_response',
      count: 1,
      match: { endpointFamily: 'quote', operationId: 'AAAAAAAAAAAAAAAAAAAAAA' },
    });

    const response = await post(
      '{}',
      '/v1/mint/quote/bolt11/quote-id',
      'AAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'GATEWAY_FAILURE' });
  });

  it('truncates a downstream response to the configured byte boundary', async () => {
    gateway!.control.setRule({
      phase: 'after_downstream_response',
      action: 'truncate',
      count: 1,
      truncateBytes: 7,
      match: { endpointFamily: 'restore' },
    });

    const truncated = await post('{}', '/v1/restore');
    expect(Buffer.byteLength(await truncated.text())).toBe(7);
    expect(gateway!.control.snapshot().truncated).toBe(1);
  });

  it('drops a request before forwarding, then permits the exact retry', async () => {
    gateway!.control.setRule({
      phase: 'before_forward',
      action: 'drop',
      occurrence: 1,
      count: 1,
      match: { method: 'POST', path: '/pay' },
    });

    await expect(post()).rejects.toThrowError(/fetch|socket|terminated/i);
    expect(bodies).toHaveLength(0);
    await expect((await post()).json()).resolves.toMatchObject({ accepted: true });
    expect(bodies).toHaveLength(1);
  });

  it('destroys the upstream socket only after the downstream response completes', async () => {
    gateway!.control.setRule({
      phase: 'after_downstream_response',
      action: 'drop',
      occurrence: 1,
      count: 1,
    });

    await expect(post()).rejects.toThrowError(/fetch|socket|terminated/i);
    expect(bodies).toHaveLength(1);
    const retry = await post();
    expect(retry.status).toBe(200);
    expect(bodies).toHaveLength(2);
  });

  it('can drop after downstream commit but before its response body completes', async () => {
    slowResponseBody = true;
    gateway!.control.setRule({
      phase: 'after_downstream_commit',
      action: 'drop',
      occurrence: 1,
      count: 1,
    });

    await expect(post()).rejects.toThrowError(/fetch|socket|terminated/i);
    expect(bodies).toHaveLength(1);
    expect(finishedResponses).toBe(0);
  });

  it('duplicates byte-identical requests without exposing bodies in control evidence', async () => {
    gateway!.control.setRule({
      phase: 'before_forward',
      action: 'duplicate',
      occurrence: 1,
      count: 1,
      duplicateCount: 99,
    });
    const original = '{"delivery":{"id":"EBESExQVFhcYGRobHB0eHw"},"proofs":["secret"]}';

    expect((await post(original)).status).toBe(200);
    expect(bodies).toHaveLength(100);
    expect(new Set(bodies.map((body) => body.toString('hex'))).size).toBe(1);
    const evidence = JSON.stringify(gateway!.control.snapshot());
    expect(evidence).not.toContain('secret');
    expect(evidence).not.toContain('proofs');
    expect(gateway!.control.snapshot().forwarded).toBe(100);
  });

  it('reorders a matched pair at the downstream boundary', async () => {
    gateway!.control.setRule({
      phase: 'before_forward',
      action: 'reorder',
      count: 2,
      delayMs: 1_000,
    });
    const firstBody = '{"delivery":{"id":"EBESExQVFhcYGRobHB0eHw"},"value":"first"}';
    const secondBody = '{"delivery":{"id":"ICEiIyQlJicoKSorLC0uLw"},"value":"second"}';

    const first = post(firstBody);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = post(secondBody);
    await Promise.all([first, second]);

    expect(bodies.map((body) => JSON.parse(body.toString('utf8')).value)).toEqual([
      'second',
      'first',
    ]);
  });

  it('injects status without touching downstream', async () => {
    gateway!.control.setRule({
      phase: 'before_forward',
      action: 'status',
      count: 1,
      statusCode: 503,
    });
    expect((await post()).status).toBe(503);
    expect(bodies).toHaveLength(0);
  });

  it('offers a bearer-gated control API with redacted evidence', async () => {
    await gateway!.close();
    gateway = new HttpFaultGateway({
      downstream: downstreamUrl,
      controlToken: 'gateway-control-secret',
    });
    gatewayUrl = await gateway.listen();

    expect((await fetch(`${gatewayUrl}/__faults/v1/evidence`)).status).toBe(401);
    const created = await fetch(`${gatewayUrl}/__faults/v1/rules`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer gateway-control-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        phase: 'before_forward',
        action: 'drop',
        count: 1,
        match: { deliveryIdHash: 'a'.repeat(64) },
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 'http-rule-1' });

    const evidence = (await (
      await fetch(`${gatewayUrl}/__faults/v1/evidence`, {
        headers: { authorization: 'Bearer gateway-control-secret' },
      })
    ).json()) as GatewayEvidence;
    expect(evidence.rules).toEqual([
      expect.objectContaining({
        id: 'http-rule-1',
        phase: 'before_forward',
        action: 'drop',
        remaining: 1,
        applied: 0,
      }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain('deliveryIdHash');
    expect(JSON.stringify(evidence)).not.toContain('aaaa');
  });

  it('reports safe exact method and path matches without delivery hashes', () => {
    gateway!.control.setRule({
      phase: 'after_downstream_response',
      action: 'drop',
      count: 1,
      match: {
        method: 'POST',
        path: '/pay',
        deliveryIdHash: 'a'.repeat(64),
      },
    });

    expect(gateway!.control.snapshot().rules).toEqual([
      {
        id: 'http-rule-1',
        phase: 'after_downstream_response',
        action: 'drop',
        method: 'POST',
        path: '/pay',
        remaining: 1,
        applied: 0,
      },
    ]);
    expect(JSON.stringify(gateway!.control.snapshot())).not.toContain('aaaa');
  });

  it('rejects unknown secret-bearing rule and match fields', () => {
    expect(() =>
      gateway!.control.setRule({
        phase: 'before_forward',
        action: 'drop',
        quoteId: 'quote-credential',
      } as never),
    ).toThrow('unknown field');
    expect(() =>
      gateway!.control.setRule({
        phase: 'before_forward',
        action: 'drop',
        match: { path: '/v1/swap', requestBody: 'proof-secret' },
      } as never),
    ).toThrow('unknown field');
  });
});
