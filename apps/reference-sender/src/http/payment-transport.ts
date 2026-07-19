import { parseDeliveryReceipt, serializeDeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { PaymentTransport, TransportResult, TransportTarget } from '../ports/transport.js';

const MAX_RESPONSE_BYTES = 65_536;
const RECEIPT_STATUSES = new Set([200, 202, 409, 410, 413, 422]);

export type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpPaymentTransportOptions {
  readonly fetch?: FetchFunction;
  readonly timeoutMs?: number;
  readonly allowPrivateNetwork?: boolean;
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['2001:db8::', 32],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

async function systemResolve(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
}

async function pinnedFetch(
  url: URL,
  init: RequestInit,
  addresses: readonly string[],
): Promise<Response> {
  const address = addresses[0];
  if (!address) throw new Error('HTTP payment target did not resolve');
  const tlsName = normalizedHostAddress(url.hostname);
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    headers.host = url.host;
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers,
        signal: init.signal ?? undefined,
        ...(url.protocol === 'https:' && isIP(tlsName) === 0 ? { servername: tlsName } : {}),
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
            status: incoming.statusCode ?? 500,
            ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
            headers: responseHeaders,
          }),
        );
      },
    );
    request.once('error', reject);
    const body = init.body;
    if (body === undefined || body === null) request.end();
    else if (typeof body === 'string' || ArrayBuffer.isView(body)) request.end(body);
    else if (body instanceof ArrayBuffer) request.end(Buffer.from(body));
    else {
      request.destroy(new Error('HTTP payment request body type is unsupported'));
    }
  });
}

function normalizedHostAddress(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, 'ipv4');
  if (family !== 6) throw new Error('HTTP payment target resolved to an invalid IP address');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  if (mapped) return blockedAddresses.check(mapped, 'ipv4');
  return blockedAddresses.check(address, 'ipv6');
}

function assertTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new Error('HTTP timeout must be an integer from 1 to 300,000 milliseconds');
  }
}

function assertPostTarget(target: TransportTarget): URL {
  if (target.type !== 'post') throw new Error('HTTP transport requires a post target');
  const url = new URL(target.target);
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('HTTP payment target must use HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('HTTP payment target cannot contain credentials or a fragment');
  }
  return url;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('HTTP payment response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString('utf8');
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('HTTP payment response is not valid JSON');
  }
}

function stableErrorCode(value: unknown, status: number): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    value.code.length > 0
  ) {
    return value.code;
  }
  return `HTTP_${status}`;
}

export class HttpPaymentTransport implements PaymentTransport {
  readonly #fetch: FetchFunction | undefined;
  readonly #timeoutMs: number;
  readonly #allowPrivateNetwork: boolean;
  readonly #resolveHost: (hostname: string) => Promise<readonly string[]>;

  constructor(options: HttpPaymentTransportOptions = {}) {
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this.#resolveHost = options.resolveHost ?? systemResolve;
    assertTimeout(this.#timeoutMs);
  }

  async #safeAddresses(url: URL): Promise<readonly string[] | undefined> {
    if (this.#allowPrivateNetwork) return undefined;
    const hostname = normalizedHostAddress(url.hostname);
    const addresses = isIP(hostname) ? [hostname] : await this.#resolveHost(hostname);
    if (addresses.length === 0) throw new Error('HTTP payment target did not resolve');
    if (addresses.some(isBlockedAddress)) {
      throw new Error('HTTP payment target resolves to a private network');
    }
    return addresses;
  }

  async send(
    payload: Uint8Array,
    target: TransportTarget,
    signal: AbortSignal,
  ): Promise<TransportResult> {
    const url = assertPostTarget(target);
    const addresses = await this.#safeAddresses(url);
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
    };
    const response = this.#fetch
      ? await this.#fetch(url.href, init)
      : addresses
        ? await pinnedFetch(url, init, addresses)
        : await fetch(url.href, init);

    if (response.status === 429 || response.status >= 500) return { kind: 'no_response' };
    if (RECEIPT_STATUSES.has(response.status)) {
      const value = await readBoundedJson(response);
      try {
        return {
          kind: 'receipt',
          receipt: serializeDeliveryReceipt(parseDeliveryReceipt(value)),
        };
      } catch {
        if (response.status === 200 || response.status === 202) {
          throw new Error('HTTP payment response does not contain a valid receipt');
        }
        return {
          kind: 'permanent_failure',
          status: response.status,
          code: stableErrorCode(value, response.status),
        };
      }
    }
    return {
      kind: 'permanent_failure',
      status: response.status,
      code: `HTTP_${response.status}`,
    };
  }
}
