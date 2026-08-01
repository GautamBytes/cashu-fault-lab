import {
  LIFECYCLE_OPERATION_KINDS,
  LIFECYCLE_PHASES,
  type LifecycleOperationIdentity,
  type LifecycleOperationKind,
  type LifecycleOperationRecord,
  type LifecyclePhase,
} from './types.js';

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const UNIT_PATTERN = /^[a-z0-9_-]{1,16}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const EVIDENCE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/u;

const kinds = new Set<string>(LIFECYCLE_OPERATION_KINDS);
const phases = new Set<string>(LIFECYCLE_PHASES);

const transitions: Readonly<Record<LifecyclePhase, ReadonlySet<LifecyclePhase>>> = {
  created: new Set(['prepared']),
  prepared: new Set(['submitted']),
  submitted: new Set(['succeeded', 'ambiguous']),
  ambiguous: new Set(['reconciling']),
  reconciling: new Set(['succeeded', 'failed_definitive', 'recovery_blocked']),
  succeeded: new Set(),
  failed_definitive: new Set(),
  recovery_blocked: new Set(),
};

const evidencedTerminalPhases = new Set<LifecyclePhase>(['failed_definitive', 'recovery_blocked']);

export function parseOperationId(value: string): string {
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new Error('Lifecycle operation ID is invalid');
  }
  return value;
}

function parseKind(value: string): LifecycleOperationKind {
  if (!kinds.has(value)) throw new Error('Lifecycle operation kind is invalid');
  return value as LifecycleOperationKind;
}

function parseMintUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Lifecycle mint URL is invalid');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Lifecycle mint URL is invalid');
  }
  const pathname =
    url.pathname === '/'
      ? ''
      : url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname;
  const canonical = `${url.protocol}//${url.host}${pathname}`;
  if (canonical !== value) throw new Error('Lifecycle mint URL is invalid');
  return value;
}

function parseUnit(value: string): string {
  if (!UNIT_PATTERN.test(value)) throw new Error('Lifecycle unit is invalid');
  return value;
}

function parseIntentHash(value: string): string {
  if (!HASH_PATTERN.test(value)) throw new Error('Lifecycle intent hash is invalid');
  return value;
}

function parsePhase(value: string): LifecyclePhase {
  if (!phases.has(value)) throw new Error('Lifecycle phase is invalid');
  return value as LifecyclePhase;
}

function parseEvidenceCode(value: string | undefined, phase: LifecyclePhase): string | undefined {
  if (evidencedTerminalPhases.has(phase)) {
    if (value === undefined || !EVIDENCE_CODE_PATTERN.test(value)) {
      throw new Error(`Lifecycle ${phase} evidence code is invalid`);
    }
    return value;
  }
  if (value !== undefined) throw new Error(`Lifecycle ${phase} evidence code is invalid`);
  return undefined;
}

export function createOperation(identity: LifecycleOperationIdentity): LifecycleOperationRecord {
  return Object.freeze({
    operationId: parseOperationId(identity.operationId),
    kind: parseKind(identity.kind),
    mint: parseMintUrl(identity.mint),
    unit: parseUnit(identity.unit),
    intentHash: parseIntentHash(identity.intentHash),
    phase: 'created',
  });
}

export function transitionOperation(
  record: LifecycleOperationRecord,
  next: LifecyclePhase,
  evidenceCode?: string,
): LifecycleOperationRecord {
  const current = parsePhase(record.phase);
  const target = parsePhase(next);
  const parsedEvidence = parseEvidenceCode(evidenceCode, target);

  if (current === target) {
    if (record.evidenceCode !== parsedEvidence) {
      throw new Error(`Lifecycle ${target} evidence code conflicts with the persisted record`);
    }
    return Object.freeze({ ...record });
  }
  if (!transitions[current].has(target)) {
    throw new Error(`invalid lifecycle transition: ${current} -> ${target}`);
  }
  return Object.freeze({
    operationId: parseOperationId(record.operationId),
    kind: parseKind(record.kind),
    mint: parseMintUrl(record.mint),
    unit: parseUnit(record.unit),
    intentHash: parseIntentHash(record.intentHash),
    phase: target,
    ...(parsedEvidence === undefined ? {} : { evidenceCode: parsedEvidence }),
  });
}
