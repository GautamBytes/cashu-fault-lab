import {
  validateAdapterResponse,
  type DeliveryReceiptView,
} from '@cashu-fault-lab/adapter-contract';
import type { CashuTsTransportPort, CashuTsTransportTarget } from './funded-operations.js';

const MAX_BODY_BYTES = 65_536;

export interface CashuTsHttpTransportOptions {
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function target(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Cashu payment target is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('Cashu payment target is invalid');
  }
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new Error('Cashu payment response is too large');
  }
  if (response.body === null) throw new Error('Cashu payment response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('Cashu payment response is too large');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('Cashu payment response is invalid');
  }
}

export class CashuTsHttpTransport implements CashuTsTransportPort {
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: CashuTsHttpTransportOptions = {}) {
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 5_000, 'timeoutMs');
    this.#fetch = options.fetch ?? fetch;
  }

  async send(destination: CashuTsTransportTarget, body: Uint8Array): Promise<DeliveryReceiptView> {
    if (destination.type !== 'post') throw new Error('Cashu HTTP transport requires a POST target');
    return this.post(destination.target, body);
  }

  async post(destination: string, body: Uint8Array): Promise<DeliveryReceiptView> {
    if (!(body instanceof Uint8Array) || body.byteLength > MAX_BODY_BYTES) {
      throw new Error('Cashu payment payload is invalid');
    }
    const url = target(destination);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body,
      });
    } catch {
      if (signal.aborted) throw new Error('Cashu payment delivery timed out');
      throw new Error('Cashu payment delivery failed');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('Cashu payment redirect is forbidden');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Cashu receiver returned HTTP ${response.status}`);
    }
    const value = await boundedJson(response);
    const validation = validateAdapterResponse('delivery', value);
    if (!validation.ok) throw new Error('Cashu payment response violates the receipt contract');
    return value as DeliveryReceiptView;
  }
}
