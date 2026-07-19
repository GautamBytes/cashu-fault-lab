import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { GatewayControl, handleControlRequest } from './control.js';
import type { FaultRule, RequestMetadata } from './rules.js';

const DEFAULT_BODY_LIMIT = 65_536;
const MAX_RESPONSE_BYTES = 65_536;

export interface HttpFaultGatewayOptions {
  readonly downstream: string;
  readonly bodyLimit?: number;
  readonly requestTimeoutMs?: number;
  readonly controlToken?: string;
}

interface DownstreamResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Buffer;
}

interface ReorderWaiter {
  readonly wait: Promise<void>;
  readonly release: () => void;
  readonly timeout: NodeJS.Timeout;
}

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_485_760) {
    throw new Error(`${name} must be an integer from 1 to 10,485,760 bytes`);
  }
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new Error('Gateway timeout must be an integer from 1 to 300,000 milliseconds');
  }
  return value;
}

async function readRequest(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > limit) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function readResponse(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('DOWNSTREAM_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function deliveryIdHash(body: Buffer): string | undefined {
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (
      typeof value === 'object' &&
      value !== null &&
      'delivery' in value &&
      typeof value.delivery === 'object' &&
      value.delivery !== null &&
      'id' in value.delivery &&
      typeof value.delivery.id === 'string'
    ) {
      return createHash('sha256').update(value.delivery.id).digest('hex');
    }
  } catch {}
  return undefined;
}

function downstreamUrl(base: URL, requestUrl: string): URL {
  const incoming = new URL(requestUrl, 'http://gateway.invalid');
  const target = new URL(base.href);
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  target.pathname = `${prefix}${incoming.pathname}`;
  target.search = incoming.search;
  target.hash = '';
  return target;
}

function forwardedHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const name of ['accept', 'content-type']) {
    const value = headers[name];
    if (typeof value === 'string') result.set(name, value);
  }
  return result;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (
      name === 'connection' ||
      name === 'content-encoding' ||
      name === 'content-length' ||
      name === 'transfer-encoding'
    ) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function destroyUpstream(response: ServerResponse): void {
  response.destroy(new Error('Injected HTTP fault'));
}

export class HttpFaultGateway {
  readonly control = new GatewayControl();
  readonly #downstream: URL;
  readonly #bodyLimit: number;
  readonly #requestTimeoutMs: number;
  readonly #controlToken: string | undefined;
  readonly #server: Server;
  readonly #reorder = new Map<string, ReorderWaiter>();

  constructor(options: HttpFaultGatewayOptions) {
    this.#downstream = new URL(options.downstream);
    if (this.#downstream.protocol !== 'http:' && this.#downstream.protocol !== 'https:') {
      throw new Error('Gateway downstream must be HTTP or HTTPS');
    }
    this.#bodyLimit = validateLimit(options.bodyLimit ?? DEFAULT_BODY_LIMIT, 'Gateway body limit');
    this.#requestTimeoutMs = validateTimeout(options.requestTimeoutMs ?? 10_000);
    this.#controlToken = options.controlToken;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (response.destroyed) return;
        const status = error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 413 : 502;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'GATEWAY_FAILURE',
            message: status === 413 ? 'Request exceeds gateway body limit' : 'Downstream failure',
          }),
        );
      });
    });
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('Gateway did not bind TCP');
    return `http://${host}:${address.port}`;
  }

  async close(): Promise<void> {
    for (const waiter of this.#reorder.values()) {
      clearTimeout(waiter.timeout);
      waiter.release();
    }
    this.#reorder.clear();
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async #dispatch(
    request: IncomingMessage,
    body: Buffer,
    copies: number,
  ): Promise<readonly Response[]> {
    const target = downstreamUrl(this.#downstream, request.url ?? '/');
    const init: RequestInit = {
      method: request.method ?? 'GET',
      headers: forwardedHeaders(request.headers),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
      ...(body.byteLength === 0 || request.method === 'GET' || request.method === 'HEAD'
        ? {}
        : { body }),
    };
    this.control.recordForward(copies);
    return Promise.all(Array.from({ length: copies }, async () => fetch(target, init)));
  }

  async #consume(responses: readonly Response[]): Promise<DownstreamResult> {
    const selected = responses[0]!;
    const selectedBody = await readResponse(selected);
    await Promise.all(responses.slice(1).map(async (response) => readResponse(response)));
    return { status: selected.status, headers: selected.headers, body: selectedBody };
  }

  async #cancel(responses: readonly Response[]): Promise<void> {
    await Promise.all(
      responses.map(async (response) => {
        try {
          await response.body?.cancel();
        } catch {}
      }),
    );
  }

  async #applyBefore(
    rule: FaultRule | undefined,
    metadata: RequestMetadata,
    response: ServerResponse,
  ): Promise<{ readonly copies: number; readonly secondReorder?: ReorderWaiter } | undefined> {
    if (!rule) return { copies: 1 };
    this.control.recordAction(rule.action, rule.duplicateCount ?? 0);
    if (rule.action === 'drop') {
      destroyUpstream(response);
      return undefined;
    }
    if (rule.action === 'status') {
      response.writeHead(rule.statusCode!, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: `INJECTED_${rule.statusCode}`, rule_id: rule.id }));
      return undefined;
    }
    if (rule.action === 'delay') await delay(rule.delayMs ?? 0);
    if (rule.action === 'duplicate') return { copies: 1 + (rule.duplicateCount ?? 1) };
    if (rule.action === 'reorder') {
      const pending = this.#reorder.get(rule.id);
      if (pending) {
        this.#reorder.delete(rule.id);
        return { copies: 1, secondReorder: pending };
      }
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const timeout = setTimeout(() => {
        this.#reorder.delete(rule.id);
        release();
      }, rule.delayMs ?? 1_000);
      this.#reorder.set(rule.id, { wait, release, timeout });
      await wait;
    }
    void metadata;
    return { copies: 1 };
  }

  async #applyAfter(rule: FaultRule | undefined, response: ServerResponse): Promise<boolean> {
    if (!rule) return true;
    this.control.recordAction(rule.action);
    if (rule.action === 'drop') {
      destroyUpstream(response);
      return false;
    }
    if (rule.action === 'delay') await delay(rule.delayMs ?? 0);
    if (rule.action === 'status') {
      response.writeHead(rule.statusCode!, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: `INJECTED_${rule.statusCode}`, rule_id: rule.id }));
      return false;
    }
    return true;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readRequest(request, this.#bodyLimit);
    const method = (request.method ?? 'GET').toUpperCase();
    const path = new URL(request.url ?? '/', 'http://gateway.invalid').pathname;
    if (
      handleControlRequest(this.control, {
        method,
        path,
        headers: request.headers,
        body,
        ...(this.#controlToken === undefined ? {} : { token: this.#controlToken }),
        response,
      })
    ) {
      return;
    }
    const hashedDeliveryId = deliveryIdHash(body);
    const metadata = this.control.begin(
      hashedDeliveryId === undefined
        ? { method, path }
        : { method, path, deliveryIdHash: hashedDeliveryId },
    );
    const before = await this.#applyBefore(
      this.control.take('before_forward', metadata),
      metadata,
      response,
    );
    if (!before) return;

    const responses = await this.#dispatch(request, body, before.copies);
    if (
      !(await this.#applyAfter(this.control.take('after_downstream_commit', metadata), response))
    ) {
      void this.#cancel(responses);
      if (before.secondReorder) {
        clearTimeout(before.secondReorder.timeout);
        before.secondReorder.release();
      }
      return;
    }
    const downstream = await this.#consume(responses);
    if (before.secondReorder) {
      clearTimeout(before.secondReorder.timeout);
      before.secondReorder.release();
    }
    if (
      !(await this.#applyAfter(this.control.take('after_downstream_response', metadata), response))
    ) {
      return;
    }
    response.writeHead(downstream.status, responseHeaders(downstream.headers));
    response.end(downstream.body);
    this.control.recordResponse();
  }
}
