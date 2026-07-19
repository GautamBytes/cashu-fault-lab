import { parseDeliveryReceipt, serializeDeliveryReceipt } from '@cashu-fault-lab/delivery-core';
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
  readonly #fetch: FetchFunction;
  readonly #timeoutMs: number;

  constructor(options: HttpPaymentTransportOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    assertTimeout(this.#timeoutMs);
  }

  async send(
    payload: Uint8Array,
    target: TransportTarget,
    signal: AbortSignal,
  ): Promise<TransportResult> {
    const url = assertPostTarget(target);
    const response = await this.#fetch(url.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
    });

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
