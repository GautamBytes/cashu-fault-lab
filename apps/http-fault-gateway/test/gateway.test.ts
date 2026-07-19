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

  async function post(body = '{"delivery":{"id":"EBESExQVFhcYGRobHB0eHw"}}') {
    return fetch(`${gatewayUrl}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  }

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
      expect.objectContaining({ id: 'http-rule-1', remaining: 1, applied: 0 }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain('deliveryIdHash');
    expect(JSON.stringify(evidence)).not.toContain('aaaa');
  });
});
