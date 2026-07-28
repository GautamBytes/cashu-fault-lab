import { AdapterNotApplicableError } from '@cashu-fault-lab/adapter-contract';
import type {
  ExternalFaultController,
  ExternalFaultEvidence,
  ExternalFaultRoute,
  ExternalFaultRuleHandle,
  ExternalFaultRuleEvidence,
} from './external-adapter-driver.js';
import type { FaultRule } from './runner.js';

const MAX_EVIDENCE_BYTES = 64 * 1_024;

export interface HttpExternalFaultControllerOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

function origin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('External fault controller URL is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error('External fault controller URL must contain only an HTTP origin');
  }
  return url.origin;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function gatewayRule(
  rule: FaultRule,
  route?: ExternalFaultRoute,
): Readonly<Record<string, unknown>> {
  const occurrence = rule.occurrence ?? 1;
  const match = route === undefined ? {} : { match: route };
  if (rule.kind === 'drop_request') {
    return { phase: 'before_forward', action: 'drop', occurrence, count: 1, ...match };
  }
  if (rule.kind === 'drop_response') {
    return {
      phase: 'after_downstream_response',
      action: 'drop',
      occurrence,
      count: 1,
      ...match,
    };
  }
  if (rule.kind === 'duplicate') {
    return {
      phase: 'before_forward',
      action: 'duplicate',
      occurrence,
      count: 1,
      duplicateCount: rule.duplicateCount ?? 1,
      ...match,
    };
  }
  if (rule.kind === 'delay') {
    return {
      phase: 'before_forward',
      action: 'delay',
      occurrence,
      count: 1,
      delayMs: rule.delayMs ?? 1,
      ...match,
    };
  }
  if (rule.kind === 'status') {
    return {
      phase: 'before_forward',
      action: 'status',
      occurrence,
      count: 1,
      statusCode: rule.statusCode ?? 503,
      ...match,
    };
  }
  throw new AdapterNotApplicableError(`Unsupported external HTTP fault kind: ${rule.kind}`);
}

function ruleHandle(
  value: unknown,
  target: string,
  mapped: Readonly<Record<string, unknown>>,
  route: ExternalFaultRoute,
): ExternalFaultRuleHandle {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Readonly<Record<string, unknown>>).id !== 'string'
  ) {
    throw new Error('External fault rule response is invalid');
  }
  return {
    id: (value as Readonly<Record<string, string>>).id!,
    target,
    phase: String(mapped.phase),
    action: String(mapped.action),
    method: route.method.toUpperCase(),
    path: route.path,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_EVIDENCE_BYTES) {
    throw new Error('External fault evidence is too large');
  }
  if (response.body === null) throw new Error('External fault evidence is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_EVIDENCE_BYTES) {
      await reader.cancel();
      throw new Error('External fault evidence is too large');
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
    throw new Error('External fault evidence is invalid');
  }
}

function evidence(value: unknown): ExternalFaultEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('External fault evidence is invalid');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.inbound !== 'number' ||
    !Number.isSafeInteger(record.inbound) ||
    record.inbound < 0 ||
    typeof record.forwarded !== 'number' ||
    !Number.isSafeInteger(record.forwarded) ||
    record.forwarded < 0
  ) {
    throw new Error('External fault evidence is invalid');
  }
  if (!Array.isArray(record.rules)) {
    throw new Error('External fault evidence is invalid');
  }
  const rules: ExternalFaultRuleEvidence[] = [];
  for (const rule of record.rules) {
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new Error('External fault evidence is invalid');
    }
    const selected = rule as Readonly<Record<string, unknown>>;
    const applied = selected.applied;
    if (
      typeof selected.id !== 'string' ||
      typeof selected.phase !== 'string' ||
      typeof selected.action !== 'string' ||
      typeof selected.method !== 'string' ||
      typeof selected.path !== 'string' ||
      typeof applied !== 'number' ||
      !Number.isSafeInteger(applied) ||
      applied < 0
    ) {
      throw new Error('External fault evidence is invalid');
    }
    rules.push({
      id: selected.id,
      target: 'http',
      phase: selected.phase,
      action: selected.action,
      method: selected.method.toUpperCase(),
      path: selected.path,
      applied,
    });
  }
  return {
    inbound: record.inbound,
    forwarded: record.forwarded,
    controller: 'http-gateway',
    observedTarget: 'http',
    rules,
  };
}

export class HttpExternalFaultController implements ExternalFaultController {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpExternalFaultControllerOptions) {
    this.#baseUrl = origin(options.baseUrl);
    if (options.token.length === 0 || /[\r\n]/u.test(options.token)) {
      throw new Error('External fault controller token is invalid');
    }
    this.#token = options.token;
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 5_000, 'timeoutMs');
    this.#fetch = options.fetch ?? fetch;
  }

  async #request(
    method: 'DELETE' | 'GET' | 'POST',
    path: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<Response> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        redirect: 'manual',
        signal,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      if (signal.aborted) throw new Error('External fault controller timed out');
      throw new Error('External fault controller request failed');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('External fault controller redirect is forbidden');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`External fault controller returned HTTP ${response.status}`);
    }
    return response;
  }

  async reset(): Promise<void> {
    const response = await this.#request('POST', '/__faults/v1/reset');
    await response.body?.cancel();
  }

  async configure(
    target: string,
    rule: FaultRule,
    route?: ExternalFaultRoute,
  ): Promise<ExternalFaultRuleHandle> {
    if (target !== 'http') {
      throw new AdapterNotApplicableError('External fault controller only supports HTTP');
    }
    if (route === undefined || route.method.length === 0 || !route.path.startsWith('/')) {
      throw new Error('External HTTP fault route is required');
    }
    const mapped = gatewayRule(rule, {
      method: route.method.toUpperCase(),
      path: route.path,
    });
    const response = await this.#request('POST', '/__faults/v1/rules', mapped);
    return ruleHandle(
      await boundedJson(response),
      target,
      mapped,
      { method: route.method.toUpperCase(), path: route.path },
    );
  }

  async clear(target?: string): Promise<void> {
    if (target !== undefined && target !== 'http') {
      throw new AdapterNotApplicableError('External fault controller only supports HTTP');
    }
    const response = await this.#request('DELETE', '/__faults/v1/rules');
    await response.body?.cancel();
  }

  async evidence(): Promise<ExternalFaultEvidence> {
    return evidence(await boundedJson(await this.#request('GET', '/__faults/v1/evidence')));
  }
}
