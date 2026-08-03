#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { NostrFaultRelay } from './relay.js';
import type { NostrFaultRuleInput } from './rules.js';

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65,535`);
  }
  return parsed;
}

function listenHost(value: string | undefined): string {
  const host = value ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error('CFL_NOSTR_FAULT_RELAY_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const MAXIMUM_CONTROL_BODY_BYTES = 1_048_576;

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAXIMUM_CONTROL_BODY_BYTES) {
        reject(new Error('Control request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new Error('Control request body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

const relay = new NostrFaultRelay();

const controlToken = process.env.CFL_NOSTR_FAULT_RELAY_TOKEN;
let controlServer: ReturnType<typeof createServer> | undefined;
if (controlToken !== undefined && controlToken !== '') {
  controlServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith('/v1/faults')) {
        json(response, 404, { code: 'NOT_FOUND', message: 'Route not found' });
        return;
      }
      if (!secureEqual(request.headers.authorization ?? '', `Bearer ${controlToken}`)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        json(response, 401, { code: 'UNAUTHORIZED', message: 'Valid control token required' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/faults/evidence') {
        json(response, 200, relay.snapshot());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/faults/rules') {
        // Runtime validation happens in validateRule; the body is untyped JSON.
        const id = relay.control.setRule((await readBody(request)) as NostrFaultRuleInput);
        json(response, 200, { id });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/faults/partition') {
        const partition = relay.control.setPartition(await readBody(request));
        json(response, 200, { partition });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/faults/reset') {
        relay.control.clear();
        relay.clearEvents();
        json(response, 200, { reset: true });
        return;
      }
      if (request.method === 'DELETE' && url.pathname === '/v1/faults') {
        relay.control.clear();
        json(response, 200, { cleared: true });
        return;
      }
      json(response, 404, { code: 'NOT_FOUND', message: 'Route not found' });
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Control request failed';
      if (!response.headersSent) json(response, 400, { code: 'BAD_REQUEST', message });
    });
  });
}

const close = async (): Promise<void> => {
  if (controlServer?.listening) {
    await new Promise<void>((resolve, reject) =>
      controlServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await relay.close();
  process.exitCode = 0;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

const url = await relay.listen(
  positiveInteger(process.env.CFL_NOSTR_FAULT_RELAY_PORT, 4400, 'CFL_NOSTR_FAULT_RELAY_PORT'),
  listenHost(process.env.CFL_NOSTR_FAULT_RELAY_HOST),
);
if (controlServer !== undefined) {
  await new Promise<void>((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(
      positiveInteger(
        process.env.CFL_NOSTR_FAULT_RELAY_CONTROL_PORT,
        4401,
        'CFL_NOSTR_FAULT_RELAY_CONTROL_PORT',
      ),
      listenHost(process.env.CFL_NOSTR_FAULT_RELAY_CONTROL_HOST),
      resolve,
    );
  });
}
process.stdout.write(`nostr fault relay listening at ${url}\n`);
