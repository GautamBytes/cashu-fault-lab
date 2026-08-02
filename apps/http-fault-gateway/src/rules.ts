import { createHash } from 'node:crypto';

export type FaultPhase = 'before_forward' | 'after_downstream_commit' | 'after_downstream_response';
export type FaultAction =
  'drop' | 'delay' | 'duplicate' | 'reorder' | 'status' | 'stale_response' | 'truncate';
export type CashuEndpointFamily = 'mint' | 'swap' | 'melt' | 'quote' | 'proof_state' | 'restore';

export interface FaultMatch {
  readonly method?: string;
  readonly path?: string;
  readonly deliveryIdHash?: string;
  readonly operationId?: string;
  readonly endpointFamily?: CashuEndpointFamily;
  readonly attemptOrdinal?: number;
}

export interface FaultRuleInput {
  readonly phase: FaultPhase;
  readonly action: FaultAction;
  readonly match?: FaultMatch;
  readonly occurrence?: number;
  readonly count?: number;
  readonly delayMs?: number;
  readonly duplicateCount?: number;
  readonly statusCode?: number;
  readonly truncateBytes?: number;
}

export interface FaultRule extends FaultRuleInput {
  readonly id: string;
  readonly count: number;
}

export interface RequestMetadata {
  readonly method: string;
  readonly path: string;
  readonly deliveryIdHash?: string;
  readonly operationIdHash?: string;
  readonly endpointFamily?: CashuEndpointFamily;
  readonly bodyDigest: string;
  readonly attemptOrdinal: number;
}

const PHASES = new Set<FaultPhase>([
  'before_forward',
  'after_downstream_commit',
  'after_downstream_response',
]);
const ACTIONS = new Set<FaultAction>([
  'drop',
  'delay',
  'duplicate',
  'reorder',
  'status',
  'stale_response',
  'truncate',
]);
const ENDPOINT_FAMILIES = new Set<CashuEndpointFamily>([
  'mint',
  'swap',
  'melt',
  'quote',
  'proof_state',
  'restore',
]);
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const RULE_FIELDS = new Set([
  'phase',
  'action',
  'match',
  'occurrence',
  'count',
  'delayMs',
  'duplicateCount',
  'statusCode',
  'truncateBytes',
]);
const MATCH_FIELDS = new Set([
  'method',
  'path',
  'deliveryIdHash',
  'operationId',
  'endpointFamily',
  'attemptOrdinal',
]);

function rejectUnknownFields(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown !== undefined) throw new Error(`${name} contains unknown field ${unknown}`);
}

export function operationIdHash(operationId: string): string {
  return createHash('sha256')
    .update('cashu-fault-lab/http-fault-operation/v1\0')
    .update(operationId)
    .digest('hex');
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 10_000) {
    throw new Error(`${name} must be an integer from 1 to 10,000`);
  }
  return result;
}

export function validateRule(id: string, input: FaultRuleInput): FaultRule {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('HTTP fault rule must be an object');
  }
  rejectUnknownFields(input as unknown as Record<string, unknown>, RULE_FIELDS, 'HTTP fault rule');
  if (input.match !== undefined) {
    if (typeof input.match !== 'object' || input.match === null || Array.isArray(input.match)) {
      throw new Error('HTTP fault match must be an object');
    }
    rejectUnknownFields(
      input.match as unknown as Record<string, unknown>,
      MATCH_FIELDS,
      'HTTP fault match',
    );
  }
  if (!PHASES.has(input.phase)) throw new Error('HTTP fault phase is invalid');
  if (!ACTIONS.has(input.action)) throw new Error('HTTP fault action is invalid');
  const count = positiveInteger(input.count, 1, 'Fault count');
  if (input.occurrence !== undefined) {
    positiveInteger(input.occurrence, 1, 'Fault occurrence');
  }
  if (input.match?.attemptOrdinal !== undefined) {
    positiveInteger(input.match.attemptOrdinal, 1, 'Attempt ordinal');
  }
  if (input.delayMs !== undefined && (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0)) {
    throw new Error('Fault delay must be a nonnegative integer');
  }
  if (input.action === 'duplicate') {
    positiveInteger(input.duplicateCount, 1, 'Duplicate count');
    if (input.phase !== 'before_forward') {
      throw new Error('Duplicate faults must run before forwarding');
    }
  }
  if (input.action === 'reorder' && input.phase !== 'before_forward') {
    throw new Error('Reorder faults must run before forwarding');
  }
  if (input.action === 'status') {
    if (
      input.statusCode === undefined ||
      !Number.isSafeInteger(input.statusCode) ||
      input.statusCode < 100 ||
      input.statusCode > 599
    ) {
      throw new Error('Injected status must be an integer from 100 to 599');
    }
  }
  if (input.action === 'stale_response' && input.phase !== 'after_downstream_response') {
    throw new Error('Stale response faults must run after a downstream response');
  }
  if (input.action === 'truncate') {
    if (input.phase !== 'after_downstream_response') {
      throw new Error('Truncate faults must run after a downstream response');
    }
    if (
      input.truncateBytes === undefined ||
      !Number.isSafeInteger(input.truncateBytes) ||
      input.truncateBytes < 0 ||
      input.truncateBytes > 65_536
    ) {
      throw new Error('Truncate bytes must be an integer from 0 to 65,536');
    }
  }
  if (input.match?.method !== undefined && input.match.method.length === 0) {
    throw new Error('Fault method match cannot be empty');
  }
  if (input.match?.path !== undefined && !input.match.path.startsWith('/')) {
    throw new Error('Fault path match must be absolute');
  }
  if (
    input.match?.endpointFamily !== undefined &&
    !ENDPOINT_FAMILIES.has(input.match.endpointFamily)
  ) {
    throw new Error('Cashu endpoint family is invalid');
  }
  if (
    input.match?.operationId !== undefined &&
    !OPERATION_ID_PATTERN.test(input.match.operationId)
  ) {
    throw new Error('Lifecycle operation ID is invalid');
  }
  return { ...structuredClone(input), id, count };
}

export function ruleMatches(
  rule: FaultRule,
  phase: FaultPhase,
  metadata: RequestMetadata,
): boolean {
  if (rule.phase !== phase) return false;
  if (rule.occurrence !== undefined && rule.occurrence !== metadata.attemptOrdinal) return false;
  const match = rule.match;
  if (!match) return true;
  if (match.method !== undefined && match.method.toUpperCase() !== metadata.method) return false;
  if (match.path !== undefined && match.path !== metadata.path) return false;
  if (match.deliveryIdHash !== undefined && match.deliveryIdHash !== metadata.deliveryIdHash) {
    return false;
  }
  if (
    match.operationId !== undefined &&
    operationIdHash(match.operationId) !== metadata.operationIdHash
  ) {
    return false;
  }
  if (match.endpointFamily !== undefined && match.endpointFamily !== metadata.endpointFamily) {
    return false;
  }
  if (match.attemptOrdinal !== undefined && match.attemptOrdinal !== metadata.attemptOrdinal) {
    return false;
  }
  return true;
}
