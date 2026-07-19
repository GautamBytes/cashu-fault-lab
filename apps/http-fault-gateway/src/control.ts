import {
  ruleMatches,
  validateRule,
  type FaultPhase,
  type FaultRule,
  type FaultRuleInput,
  type RequestMetadata,
} from './rules.js';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';

const CONTROL_PREFIX = '/__faults/v1/';
const CONTROL_BODY_LIMIT = 16_384;

interface RuleState {
  readonly rule: FaultRule;
  remaining: number;
  applied: number;
}

export interface GatewayEvidence {
  readonly inbound: number;
  readonly forwarded: number;
  readonly responded: number;
  readonly dropped: number;
  readonly delayed: number;
  readonly duplicates: number;
  readonly reordered: number;
  readonly statusInjected: number;
  readonly rules: readonly {
    readonly id: string;
    readonly phase: FaultPhase;
    readonly action: FaultRule['action'];
    readonly remaining: number;
    readonly applied: number;
  }[];
}

export class GatewayControl {
  #sequence = 0;
  readonly #rules: RuleState[] = [];
  readonly #attempts = new Map<string, number>();
  readonly #counters = {
    inbound: 0,
    forwarded: 0,
    responded: 0,
    dropped: 0,
    delayed: 0,
    duplicates: 0,
    reordered: 0,
    statusInjected: 0,
  };

  setRule(input: FaultRuleInput): FaultRule {
    const rule = validateRule(`http-rule-${++this.#sequence}`, input);
    this.#rules.push({ rule, remaining: rule.count, applied: 0 });
    return structuredClone(rule);
  }

  clearRules(): void {
    this.#rules.splice(0);
  }

  reset(): void {
    this.clearRules();
    this.#attempts.clear();
    this.#counters.inbound = 0;
    this.#counters.forwarded = 0;
    this.#counters.responded = 0;
    this.#counters.dropped = 0;
    this.#counters.delayed = 0;
    this.#counters.duplicates = 0;
    this.#counters.reordered = 0;
    this.#counters.statusInjected = 0;
  }

  begin(input: Omit<RequestMetadata, 'attemptOrdinal'>): RequestMetadata {
    this.#counters.inbound += 1;
    const key = `${input.method}\0${input.path}\0${input.deliveryIdHash ?? '-'}`;
    const attemptOrdinal = (this.#attempts.get(key) ?? 0) + 1;
    this.#attempts.set(key, attemptOrdinal);
    return { ...input, attemptOrdinal };
  }

  take(phase: FaultPhase, metadata: RequestMetadata): FaultRule | undefined {
    const state = this.#rules.find(
      (candidate) => candidate.remaining > 0 && ruleMatches(candidate.rule, phase, metadata),
    );
    if (!state) return undefined;
    state.remaining -= 1;
    state.applied += 1;
    return state.rule;
  }

  recordForward(count = 1): void {
    this.#counters.forwarded += count;
  }

  recordResponse(): void {
    this.#counters.responded += 1;
  }

  recordAction(action: FaultRule['action'], extra = 0): void {
    if (action === 'drop') this.#counters.dropped += 1;
    if (action === 'delay') this.#counters.delayed += 1;
    if (action === 'duplicate') this.#counters.duplicates += extra;
    if (action === 'reorder') this.#counters.reordered += 1;
    if (action === 'status') this.#counters.statusInjected += 1;
  }

  snapshot(): GatewayEvidence {
    return {
      ...this.#counters,
      rules: this.#rules.map(({ rule, remaining, applied }) => ({
        id: rule.id,
        phase: rule.phase,
        action: rule.action,
        remaining,
        applied,
      })),
    };
  }
}

export interface ControlHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly token?: string;
  readonly response: ServerResponse;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function decodeRule(body: Buffer): FaultRuleInput {
  if (body.byteLength > CONTROL_BODY_LIMIT) throw new Error('CONTROL_PAYLOAD_TOO_LARGE');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as FaultRuleInput;
  } catch (error) {
    if (error instanceof Error && error.message === 'CONTROL_PAYLOAD_TOO_LARGE') throw error;
    throw new Error('INVALID_CONTROL_JSON');
  }
}

export function handleControlRequest(
  control: GatewayControl,
  request: ControlHttpRequest,
): boolean {
  if (!request.path.startsWith(CONTROL_PREFIX)) return false;
  if (!request.token) {
    json(request.response, 404, { code: 'NOT_FOUND', message: 'Route not found' });
    return true;
  }
  if (!secureEqual(request.headers.authorization ?? '', `Bearer ${request.token}`)) {
    request.response.setHeader('WWW-Authenticate', 'Bearer');
    json(request.response, 401, { code: 'UNAUTHORIZED', message: 'Valid control token required' });
    return true;
  }

  if (request.method === 'GET' && request.path === `${CONTROL_PREFIX}evidence`) {
    json(request.response, 200, control.snapshot());
    return true;
  }
  if (request.method === 'POST' && request.path === `${CONTROL_PREFIX}rules`) {
    try {
      const rule = control.setRule(decodeRule(request.body));
      json(request.response, 201, { id: rule.id });
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'CONTROL_PAYLOAD_TOO_LARGE';
      json(request.response, tooLarge ? 413 : 422, {
        code: tooLarge ? 'CONTROL_PAYLOAD_TOO_LARGE' : 'INVALID_FAULT_RULE',
        message: tooLarge ? 'Control body exceeds 16,384 bytes' : 'Fault rule is invalid',
      });
    }
    return true;
  }
  if (request.method === 'DELETE' && request.path === `${CONTROL_PREFIX}rules`) {
    control.clearRules();
    json(request.response, 200, { ok: true });
    return true;
  }
  if (request.method === 'POST' && request.path === `${CONTROL_PREFIX}reset`) {
    control.reset();
    json(request.response, 200, { ok: true });
    return true;
  }
  json(request.response, 404, { code: 'NOT_FOUND', message: 'Control route not found' });
  return true;
}
