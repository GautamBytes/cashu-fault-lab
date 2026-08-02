import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const BODY_LIMIT = 8_192;
const RESPONSE_LIMIT = 32_768;
const DIGEST = /^[0-9a-f]{64}$/u;
const MACAROON = /^(?:[0-9a-f]{2}){16,4096}$/u;
const REQUEST_KEYS = new Set(['invoice', 'invoiceHash', 'quoteHash']);

export interface LightningRegtestProbeOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly lndUrl: string;
  readonly lndMacaroonHex?: string;
  readonly timeoutMs?: number;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function invoiceDigest(invoice: string): string {
  return createHash('sha256')
    .update('cashu-fault-lab/lightning-invoice/v1\0')
    .update(invoice)
    .digest('hex');
}

function validatedLndUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/'
  ) {
    throw new Error('Lightning regtest probe LND URL is invalid');
  }
  return url;
}

async function responseJson(response: Response): Promise<Readonly<Record<string, unknown>>> {
  if (!response.ok || response.status >= 300) throw new Error('LND request failed');
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > RESPONSE_LIMIT) {
    throw new Error('LND response is too large');
  }
  if (response.body === null) throw new Error('LND response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error('LND response is too large');
    }
    chunks.push(chunk.value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('LND response is invalid');
  }
  return value as Readonly<Record<string, unknown>>;
}

async function bodyJson(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > BODY_LIMIT) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('INVALID_REQUEST');
  }
  const input = value as Readonly<Record<string, unknown>>;
  if (Object.keys(input).some((key) => !REQUEST_KEYS.has(key))) {
    throw new Error('INVALID_REQUEST');
  }
  return input;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

export class LightningRegtestProbe {
  readonly #options: LightningRegtestProbeOptions;
  readonly #lndUrl: URL;
  #server: Server | undefined;

  constructor(options: LightningRegtestProbeOptions) {
    if (options.token.length < 16 || options.token.length > 4_096) {
      throw new Error('Lightning regtest probe token is invalid');
    }
    if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error('Lightning regtest probe port is invalid');
    }
    this.#options = options;
    this.#lndUrl = validatedLndUrl(options.lndUrl);
    if (options.lndMacaroonHex !== undefined && !MACAROON.test(options.lndMacaroonHex)) {
      throw new Error('Lightning regtest probe macaroon is invalid');
    }
  }

  async #lnd(path: string): Promise<Readonly<Record<string, unknown>>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 5_000);
    try {
      return await responseJson(
        await fetch(new URL(path, this.#lndUrl), {
          method: 'GET',
          ...(this.#options.lndMacaroonHex === undefined
            ? {}
            : { headers: { 'grpc-metadata-macaroon': this.#options.lndMacaroonHex } }),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
        }),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async assertRegtest(): Promise<void> {
    const info = await this.#lnd('/v1/getinfo');
    const chains = Reflect.get(info, 'chains');
    if (
      !Array.isArray(chains) ||
      !chains.some(
        (chain) =>
          typeof chain === 'object' &&
          chain !== null &&
          Reflect.get(chain, 'chain') === 'bitcoin' &&
          Reflect.get(chain, 'network') === 'regtest',
      )
    ) {
      throw new Error('Lightning probe refuses a non-regtest LND node');
    }
  }

  async settled(invoice: string): Promise<boolean> {
    const decoded = await this.#lnd(`/v1/payreq/${encodeURIComponent(invoice)}`);
    const paymentHash = Reflect.get(decoded, 'payment_hash');
    if (typeof paymentHash !== 'string' || !DIGEST.test(paymentHash)) return false;
    const invoiceState = await this.#lnd(`/v1/invoice/${paymentHash}`);
    return (
      Reflect.get(invoiceState, 'settled') === true ||
      Reflect.get(invoiceState, 'state') === 'SETTLED'
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/health') {
      send(response, 200, { ok: true, chain: 'bitcoin', network: 'regtest' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/settlement') {
      send(response, 404, { code: 'NOT_FOUND' });
      return;
    }
    if (!secureEqual(request.headers.authorization ?? '', `Bearer ${this.#options.token}`)) {
      send(response, 401, { code: 'UNAUTHORIZED' });
      return;
    }
    try {
      const input = await bodyJson(request);
      const invoice = input.invoice;
      const suppliedInvoiceHash = input.invoiceHash;
      const quoteHash = input.quoteHash;
      if (
        typeof invoice !== 'string' ||
        invoice.length < 16 ||
        invoice.length > 4_096 ||
        typeof suppliedInvoiceHash !== 'string' ||
        !DIGEST.test(suppliedInvoiceHash) ||
        suppliedInvoiceHash !== invoiceDigest(invoice) ||
        typeof quoteHash !== 'string' ||
        !DIGEST.test(quoteHash)
      ) {
        send(response, 422, { code: 'INVALID_BINDING' });
        return;
      }
      send(response, 200, {
        settled: await this.settled(invoice),
        invoiceHash: suppliedInvoiceHash,
        quoteHash,
      });
    } catch (error) {
      send(response, error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 413 : 502, {
        code: 'SETTLEMENT_UNAVAILABLE',
      });
    }
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) throw new Error('Lightning regtest probe is already started');
    await this.assertRegtest();
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(this.#options.port, this.#options.host, resolve);
    });
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}
