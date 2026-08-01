import { parseOperationId } from '@cashu-fault-lab/wallet-lifecycle-core';
import type {
  LifecycleAdapterClient,
  LifecycleCapabilities,
  LifecycleEvidenceView,
  LifecycleOperationInput,
  LifecycleOperationView,
  LifecycleRequestOperation,
  LifecycleResponseOperation,
  LifecycleWalletView,
} from './types.js';
import { validateLifecycleRequest, validateLifecycleResponse } from './validation.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1_024;

export interface HttpLifecycleAdapterClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

export class LifecycleAdapterClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LifecycleAdapterClientError';
  }
}

export class LifecycleAdapterNotApplicableError extends LifecycleAdapterClientError {
  constructor(readonly reason: string) {
    super('LIFECYCLE_ADAPTER_NOT_APPLICABLE', reason);
    this.name = 'LifecycleAdapterNotApplicableError';
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function adapterOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Lifecycle adapter base URL is invalid');
  }
  const loopbackHost = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    url.protocol !== 'http:' ||
    !loopbackHost ||
    url.origin === 'null' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error('Lifecycle adapter base URL must be a loopback HTTP origin');
  }
  return url.origin;
}

function publicErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const code = (value as Readonly<Record<string, unknown>>).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : undefined;
}

function notApplicableReason(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  return record.status === 'N/A' && typeof record.reason === 'string' && record.reason.length > 0
    ? record.reason
    : undefined;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    throw new LifecycleAdapterClientError(
      'LIFECYCLE_ADAPTER_RESPONSE_TOO_LARGE',
      'Lifecycle adapter response exceeds the configured size limit',
    );
  }
  if (response.body === null) {
    throw new LifecycleAdapterClientError(
      'LIFECYCLE_ADAPTER_RESPONSE',
      'Lifecycle adapter response body is empty',
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new LifecycleAdapterClientError(
        'LIFECYCLE_ADAPTER_RESPONSE_TOO_LARGE',
        'Lifecycle adapter response exceeds the configured size limit',
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
    throw new LifecycleAdapterClientError(
      'LIFECYCLE_ADAPTER_RESPONSE',
      'Lifecycle adapter response is not valid JSON',
    );
  }
}

export class HttpLifecycleAdapterClient implements LifecycleAdapterClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpLifecycleAdapterClientOptions) {
    this.#baseUrl = adapterOrigin(options.baseUrl);
    if (options.token.length === 0 || /[\r\n]/u.test(options.token)) {
      throw new Error('Lifecycle adapter control token is invalid');
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
    responseOperation: LifecycleResponseOperation,
    method: 'GET' | 'POST',
    path: string,
    request?: { readonly operation: LifecycleRequestOperation; readonly value: unknown },
  ): Promise<T> {
    if (request !== undefined) {
      const validation = validateLifecycleRequest(request.operation, request.value);
      if (!validation.ok) {
        throw new LifecycleAdapterClientError(
          'LIFECYCLE_ADAPTER_REQUEST_CONTRACT',
          `Lifecycle adapter request violates ${request.operation} contract`,
        );
      }
    }
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl) {
      throw new LifecycleAdapterClientError(
        'LIFECYCLE_ADAPTER_ORIGIN',
        'Lifecycle adapter request changed configured origin',
      );
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
      throw new LifecycleAdapterClientError(
        signal.aborted ? 'LIFECYCLE_ADAPTER_TIMEOUT' : 'LIFECYCLE_ADAPTER_UNAVAILABLE',
        signal.aborted ? 'Lifecycle adapter request timed out' : 'Lifecycle adapter request failed',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new LifecycleAdapterClientError(
        'LIFECYCLE_ADAPTER_REDIRECT',
        'Lifecycle adapter redirects are forbidden',
      );
    }
    const value = await boundedJson(response, this.#maxResponseBytes);
    if (response.status === 501) {
      const reason = notApplicableReason(value);
      if (reason !== undefined) throw new LifecycleAdapterNotApplicableError(reason);
    }
    if (!response.ok) {
      const code = publicErrorCode(value);
      throw new LifecycleAdapterClientError(
        'LIFECYCLE_ADAPTER_HTTP_STATUS',
        `Lifecycle adapter returned HTTP status ${response.status}${code === undefined ? '' : ` (${code})`}`,
      );
    }
    const validation = validateLifecycleResponse(responseOperation, value);
    if (!validation.ok) {
      throw new LifecycleAdapterClientError(
        'LIFECYCLE_ADAPTER_CONTRACT',
        `Lifecycle adapter response violates ${responseOperation} contract`,
      );
    }
    return value as T;
  }

  capabilities(): Promise<LifecycleCapabilities> {
    return this.#request('capabilities', 'GET', '/v1/lifecycle/capabilities');
  }

  async reset(seed: string): Promise<void> {
    await this.#request('reset', 'POST', '/v1/lifecycle/reset', {
      operation: 'reset',
      value: { seed },
    });
  }

  start(input: LifecycleOperationInput): Promise<LifecycleOperationView> {
    return this.#request('start', 'POST', '/v1/lifecycle/operations', {
      operation: 'start',
      value: input,
    });
  }

  resume(operationId: string): Promise<LifecycleOperationView> {
    parseOperationId(operationId);
    return this.#request('resume', 'POST', `/v1/lifecycle/operations/${operationId}/resume`);
  }

  operation(operationId: string): Promise<LifecycleOperationView> {
    parseOperationId(operationId);
    return this.#request('operation', 'GET', `/v1/lifecycle/operations/${operationId}`);
  }

  wallet(): Promise<LifecycleWalletView> {
    return this.#request('wallet', 'GET', '/v1/lifecycle/wallet');
  }

  evidence(): Promise<readonly LifecycleEvidenceView[]> {
    return this.#request('evidence', 'GET', '/v1/lifecycle/evidence');
  }
}
