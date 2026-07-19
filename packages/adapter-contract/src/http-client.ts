import { parseProtocolId } from '@cashu-fault-lab/delivery-core';
import type {
  AdapterCapabilities,
  AdapterClient,
  AdapterRequestOperation,
  AdapterResponseOperation,
  CreateRequestInput,
  DeliveryReceiptView,
  LedgerCreditView,
  PaymentRequestView,
  ProofEvidenceView,
  SendPaymentInput,
} from './types.js';
import { validateAdapterRequest, validateAdapterResponse } from './validation.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1_024;

export interface HttpAdapterClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

export class AdapterClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterClientError';
  }
}

export class AdapterNotApplicableError extends AdapterClientError {
  constructor(readonly reason: string) {
    super('ADAPTER_NOT_APPLICABLE', reason);
    this.name = 'AdapterNotApplicableError';
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function origin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Adapter base URL is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin === 'null' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error('Adapter base URL must contain only an HTTP or HTTPS origin');
  }
  return url.origin;
}

function unsupported(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).some((key) => key !== 'status' && key !== 'reason') ||
    record.status !== 'N/A' ||
    typeof record.reason !== 'string' ||
    record.reason.length === 0
  ) {
    return undefined;
  }
  return record.reason;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    throw new AdapterClientError(
      'ADAPTER_RESPONSE_TOO_LARGE',
      'Adapter response exceeds the configured size limit',
    );
  }
  if (response.body === null) {
    throw new AdapterClientError('ADAPTER_RESPONSE', 'Adapter response body is empty');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new AdapterClientError(
        'ADAPTER_RESPONSE_TOO_LARGE',
        'Adapter response exceeds the configured size limit',
      );
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
    throw new AdapterClientError('ADAPTER_RESPONSE', 'Adapter response is not valid JSON');
  }
}

export class HttpAdapterClient implements AdapterClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpAdapterClientOptions) {
    this.#baseUrl = origin(options.baseUrl);
    if (options.token.length === 0 || /[\r\n]/u.test(options.token)) {
      throw new Error('Adapter control token is invalid');
    }
    this.#token = options.token;
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.#maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    );
    this.#fetch = options.fetch ?? fetch;
  }

  async #request<T>(
    responseOperation: AdapterResponseOperation,
    method: 'GET' | 'POST',
    path: string,
    request?: { readonly operation: AdapterRequestOperation; readonly value: unknown },
  ): Promise<T> {
    if (request !== undefined) {
      const validation = validateAdapterRequest(request.operation, request.value);
      if (!validation.ok) {
        throw new AdapterClientError(
          'ADAPTER_REQUEST_CONTRACT',
          `Adapter request violates ${request.operation} contract`,
        );
      }
    }
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl) {
      throw new AdapterClientError('ADAPTER_ORIGIN', 'Adapter request changed configured origin');
    }
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        redirect: 'manual',
        signal,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(request === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request === undefined ? {} : { body: JSON.stringify(request.value) }),
      });
    } catch {
      if (signal.aborted) {
        throw new AdapterClientError('ADAPTER_TIMEOUT', 'Adapter request timed out');
      }
      throw new AdapterClientError('ADAPTER_UNAVAILABLE', 'Adapter request failed');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AdapterClientError('ADAPTER_REDIRECT', 'Adapter redirects are forbidden');
    }
    const value = await boundedJson(response, this.#maxResponseBytes);
    if (response.status === 501) {
      const reason = unsupported(value);
      if (reason !== undefined) throw new AdapterNotApplicableError(reason);
      throw new AdapterClientError(
        'ADAPTER_RESPONSE',
        'Adapter unsupported response violates the contract',
      );
    }
    if (!response.ok) {
      throw new AdapterClientError(
        'ADAPTER_HTTP_STATUS',
        `Adapter returned HTTP status ${response.status}`,
      );
    }
    const validation = validateAdapterResponse(responseOperation, value);
    if (!validation.ok) {
      throw new AdapterClientError(
        'ADAPTER_CONTRACT',
        `Adapter response violates ${responseOperation} contract`,
      );
    }
    return value as T;
  }

  capabilities(): Promise<AdapterCapabilities> {
    return this.#request('capabilities', 'GET', '/v1/capabilities');
  }

  async reset(seed: string): Promise<void> {
    await this.#request('reset', 'POST', '/v1/reset', {
      operation: 'reset',
      value: { seed },
    });
  }

  createRequest(input: CreateRequestInput): Promise<PaymentRequestView> {
    return this.#request('createRequest', 'POST', '/v1/requests', {
      operation: 'createRequest',
      value: input,
    });
  }

  send(input: SendPaymentInput): Promise<DeliveryReceiptView> {
    return this.#request('send', 'POST', '/v1/send', { operation: 'send', value: input });
  }

  delivery(deliveryId: string): Promise<DeliveryReceiptView> {
    parseProtocolId(deliveryId);
    return this.#request('delivery', 'GET', `/v1/deliveries/${deliveryId}`);
  }

  ledger(): Promise<readonly LedgerCreditView[]> {
    return this.#request('ledger', 'GET', '/v1/ledger');
  }

  proofs(): Promise<readonly ProofEvidenceView[]> {
    return this.#request('proofs', 'GET', '/v1/proofs');
  }
}
