import { createHash } from 'node:crypto';
import type { CashuTsLifecycleLightningPort } from './wallet.js';

const MAX_RESPONSE_BYTES = 8_192;

export interface HttpCashuTsLifecycleLightningProbeOptions {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly allowUnsafeExternal?: boolean;
}

function loopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized === '::1'
  );
}

function validatedUrl(value: string, allowUnsafeExternal: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Cashu lifecycle Lightning probe URL is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Cashu lifecycle Lightning probe URL is invalid');
  }
  if (!loopback(url.hostname) && (!allowUnsafeExternal || url.protocol !== 'https:')) {
    throw new Error('Cashu lifecycle external Lightning probe requires explicit HTTPS opt-in');
  }
  return url;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new Error('Cashu lifecycle Lightning probe response is too large');
  }
  if (response.body === null) throw new Error('Cashu lifecycle Lightning probe response is empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Cashu lifecycle Lightning probe response is too large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function invoiceHash(invoice: string): string {
  return createHash('sha256')
    .update('cashu-fault-lab/lightning-invoice/v1\0')
    .update(invoice)
    .digest('hex');
}

/**
 * Read-only, independently operated settlement probe used to corroborate a PAID mint quote.
 * The probe contract accepts `{invoice, invoiceHash, quoteHash}` and returns all three bindings
 * with `settled`; no response body is ever persisted as lifecycle evidence.
 */
export class HttpCashuTsLifecycleLightningProbe implements CashuTsLifecycleLightningPort {
  readonly #url: URL;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(options: HttpCashuTsLifecycleLightningProbeOptions) {
    if (options.token.length < 16 || options.token.length > 4_096) {
      throw new Error('Cashu lifecycle Lightning probe token is invalid');
    }
    this.#url = validatedUrl(options.url, options.allowUnsafeExternal === true);
    this.#token = options.token;
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 5_000, 'timeoutMs');
  }

  async settled(invoice: string, quoteHash: string): Promise<boolean> {
    const expectedInvoiceHash = invoiceHash(invoice);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(this.#url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ invoice, invoiceHash: expectedInvoiceHash, quoteHash }),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrer: '',
        referrerPolicy: 'no-referrer',
        redirect: 'manual',
      });
      if (!response.ok || (response.status >= 300 && response.status < 400)) return false;
      const value = await boundedJson(response);
      if (typeof value !== 'object' || value === null) return false;
      return (
        Reflect.get(value, 'settled') === true &&
        Reflect.get(value, 'invoiceHash') === expectedInvoiceHash &&
        Reflect.get(value, 'quoteHash') === quoteHash
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
