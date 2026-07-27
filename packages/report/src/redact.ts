import {
  redact,
  type EvidenceConfidence,
  type FailureArtifact,
  type HistoryEvent,
  type InvariantEvidenceReference,
  type InvariantId,
  type InvariantResult,
  type InvariantStatus,
  type ScenarioCommand,
  type ScenarioRunResult,
} from '@cashu-fault-lab/scenario-runner';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:(?!([0-9a-f])\1{63}$)[0-9a-f]{64}$/;
const METADATA_KEY_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$/;

export interface ReportInput {
  readonly result: ScenarioRunResult;
  readonly componentVersions?: Readonly<Record<string, string>>;
  readonly imageDigests?: Readonly<Record<string, string>>;
}

export type ReportInvariant = InvariantResult;

export interface ReportFailure {
  readonly code: string;
  readonly message: string;
}

export interface ReportTimelineEvent {
  readonly sequence: number;
  readonly at: number;
  readonly phase: HistoryEvent['phase'];
  readonly actor: string;
  readonly event: string;
  readonly commandIndex?: number;
  readonly outcome?: HistoryEvent['outcome'];
  readonly data?: Readonly<Record<string, string | number | boolean>>;
}

export interface ReportImplementationIdentity {
  readonly id: string;
  readonly version: string;
  readonly language: string;
  readonly runtime: string;
  readonly sourceDigest: string;
  readonly buildDigest: string;
}

export interface ReportRoleCapability {
  readonly transports: readonly string[];
  readonly profiles: readonly string[];
  readonly durability: string;
  readonly evidence: {
    readonly tier: string;
    readonly sources: readonly string[];
  };
}

export interface ReportCapabilities {
  readonly schemaVersion?: 2;
  readonly implementation?: ReportImplementationIdentity;
  readonly roles?: {
    readonly sender?: ReportRoleCapability;
    readonly receiver?: ReportRoleCapability;
  };
  readonly nuts?: readonly number[];
  readonly encodings?: readonly string[];
  readonly mints?: readonly {
    readonly id: string;
    readonly implementation: string;
    readonly version?: string;
  }[];
  readonly sender?:
    | string
    | {
        readonly implementation: ReportImplementationIdentity;
        readonly role?: ReportRoleCapability;
      };
  readonly receiver?:
    | string
    | {
        readonly implementation: ReportImplementationIdentity;
        readonly role?: ReportRoleCapability;
      };
}

export interface ReportDocument {
  readonly schemaVersion: 2;
  readonly scenarioId: string;
  readonly seed: string;
  readonly status: ScenarioRunResult['status'];
  readonly invariants: readonly ReportInvariant[];
  readonly commands: readonly Readonly<Record<string, string | number | boolean | undefined>>[];
  readonly timeline: readonly ReportTimelineEvent[];
  readonly capabilities: ReportCapabilities;
  readonly componentVersions: Readonly<Record<string, string>>;
  readonly imageDigests: Readonly<Record<string, string>>;
  readonly failure?: ReportFailure;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`);
  return value;
}

function commandView(
  command: ScenarioCommand,
): Readonly<Record<string, string | number | boolean | undefined>> {
  switch (command.type) {
    case 'configure_fault':
      return {
        type: command.type,
        target: command.target,
        fault: command.rule.kind,
        occurrence: command.rule.occurrence,
        delayMs: command.rule.delayMs,
        duplicateCount: command.rule.duplicateCount,
        statusCode: command.rule.statusCode,
      };
    case 'send':
      return { type: command.type, sender: command.sender, requestId: command.requestId };
    case 'restart':
      return { type: command.type, component: command.component };
    case 'advance_time':
      return { type: command.type, milliseconds: command.milliseconds };
    case 'clear_faults':
      return { type: command.type, target: command.target };
    case 'assert_quiescent':
      return { type: command.type };
  }
}

const OBSERVATION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  request_observed: ['requestId', 'singleUse'],
  delivery_attempted: ['requestId', 'deliveryId', 'payloadHash', 'proofSetHash', 'transport'],
  redemption_started: ['deliveryId', 'proofSetHash'],
  mint_proofs_state: ['proofSetHash', 'state'],
  receiver_settled: ['deliveryId', 'replacementPlanHash'],
  merchant_credited: ['creditId', 'requestId', 'deliveryId', 'amount', 'unit'],
  receipt_observed: [
    'requestId',
    'deliveryId',
    'payloadHash',
    'status',
    'detailCode',
    'version',
    'amount',
    'unit',
  ],
};

function observationView(event: HistoryEvent): Readonly<Record<string, string | number | boolean>> {
  if (!isRecord(event.data)) return {};
  const allowed = OBSERVATION_FIELDS[event.event];
  if (!allowed) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    const value = event.data[key];
    if (typeof value === 'string' || typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) result[key] = value;
  }
  return result;
}

function timelineView(event: HistoryEvent): ReportTimelineEvent {
  const data = event.phase === 'observation' ? observationView(event) : {};
  return {
    sequence: safeInteger(event.sequence, 'History sequence'),
    at: safeInteger(event.at, 'History time'),
    phase: event.phase,
    actor: event.actor,
    event: event.event,
    ...(event.commandIndex === undefined
      ? {}
      : { commandIndex: safeInteger(event.commandIndex, 'Command index') }),
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
    ...(Object.keys(data).length === 0 ? {} : { data }),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;
}

function implementationView(value: unknown): ReportImplementationIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringField(value.id);
  const version = stringField(value.version);
  const language = stringField(value.language);
  const runtime = stringField(value.runtime);
  const sourceDigest = stringField(value.sourceDigest);
  const buildDigest = stringField(value.buildDigest);
  if (
    id === undefined ||
    version === undefined ||
    language === undefined ||
    runtime === undefined ||
    sourceDigest === undefined ||
    buildDigest === undefined ||
    !DIGEST_PATTERN.test(sourceDigest) ||
    !DIGEST_PATTERN.test(buildDigest)
  ) {
    return undefined;
  }
  return { id, version, language, runtime, sourceDigest, buildDigest };
}

function roleView(value: unknown): ReportRoleCapability | undefined {
  if (!isRecord(value) || !isRecord(value.evidence)) return undefined;
  const transports = stringArray(value.transports);
  const profiles = stringArray(value.profiles);
  const durability = stringField(value.durability);
  const tier = stringField(value.evidence.tier);
  const sources = stringArray(value.evidence.sources);
  if (
    transports === undefined ||
    profiles === undefined ||
    durability === undefined ||
    tier === undefined ||
    sources === undefined
  ) {
    return undefined;
  }
  return { transports, profiles, durability, evidence: { tier, sources } };
}

function participantView(
  value: unknown,
): Exclude<ReportCapabilities['sender'], string | undefined> | undefined {
  if (!isRecord(value)) return undefined;
  const implementation = implementationView(value.implementation);
  if (implementation === undefined) return undefined;
  const role = roleView(value.role);
  return {
    implementation,
    ...(role === undefined ? {} : { role }),
  };
}

function capabilitiesView(value: FailureArtifact['capabilities']): ReportCapabilities {
  const implementation = implementationView(value.implementation);
  const sender = participantView(value.sender) ?? stringField(value.sender);
  const receiver = participantView(value.receiver) ?? stringField(value.receiver);
  const senderRole = isRecord(value.roles) ? roleView(value.roles.sender) : undefined;
  const receiverRole = isRecord(value.roles) ? roleView(value.roles.receiver) : undefined;
  const roles =
    senderRole === undefined && receiverRole === undefined
      ? undefined
      : {
          ...(senderRole === undefined ? {} : { sender: senderRole }),
          ...(receiverRole === undefined ? {} : { receiver: receiverRole }),
        };
  const nuts = Array.isArray(value.nuts)
    ? value.nuts.filter((item): item is number => Number.isSafeInteger(item) && Number(item) >= 0)
    : undefined;
  const encodings = stringArray(value.encodings);
  const mints = Array.isArray(value.mints)
    ? value.mints.flatMap((item) => {
        if (!isRecord(item)) return [];
        const id = stringField(item.id);
        const mintImplementation = stringField(item.implementation);
        const version = stringField(item.version);
        return id === undefined || mintImplementation === undefined
          ? []
          : [{ id, implementation: mintImplementation, ...(version ? { version } : {}) }];
      })
    : undefined;
  return {
    ...(value.schemaVersion === 2 ? { schemaVersion: 2 as const } : {}),
    ...(implementation ? { implementation } : {}),
    ...(roles && Object.keys(roles).length > 0 ? { roles } : {}),
    ...(nuts ? { nuts } : {}),
    ...(encodings ? { encodings } : {}),
    ...(mints ? { mints } : {}),
    ...(sender ? { sender } : {}),
    ...(receiver ? { receiver } : {}),
  };
}

const INVARIANT_STATUSES = new Set<InvariantStatus>([
  'passed',
  'failed',
  'not_applicable',
  'not_observable',
]);
const EVIDENCE_CONFIDENCE = new Set<EvidenceConfidence>(['observed', 'derived', 'adapter_claimed']);
const EVIDENCE_SOURCES = new Set<InvariantEvidenceReference['source']>([
  'timeline',
  'receipt',
  'ledger',
  'proofs',
  'capabilities',
]);

function safeText(value: string): string {
  const sanitized = redact(value);
  return typeof sanitized === 'string' ? sanitized : '';
}

function invariantView(value: InvariantResult): ReportInvariant {
  if (
    typeof value.id !== 'string' ||
    !INVARIANT_STATUSES.has(value.status) ||
    !EVIDENCE_CONFIDENCE.has(value.confidence) ||
    !Array.isArray(value.evidence)
  ) {
    throw new Error('Invariant result is invalid');
  }
  const evidence = value.evidence.map((reference): InvariantEvidenceReference => {
    if (!EVIDENCE_SOURCES.has(reference.source)) {
      throw new Error('Invariant evidence source is invalid');
    }
    return {
      source: reference.source,
      ...(reference.index === undefined
        ? {}
        : { index: safeInteger(reference.index, 'Invariant evidence index') }),
      ...(reference.field === undefined ? {} : { field: safeText(reference.field) }),
      description: safeText(reference.description),
    };
  });
  return {
    id: value.id as InvariantId,
    status: value.status,
    confidence: value.confidence,
    evidence,
    ...(value.reason === undefined ? {} : { reason: safeText(value.reason) }),
  };
}

function metadata(
  value: Readonly<Record<string, string>> | undefined,
  kind: 'version' | 'digest',
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!METADATA_KEY_PATTERN.test(key)) throw new Error(`${kind} metadata key is invalid`);
    const valid = kind === 'version' ? VERSION_PATTERN.test(item) : DIGEST_PATTERN.test(item);
    if (!valid) throw new Error(`${kind} metadata value is invalid`);
    result[key] = item;
  }
  return result;
}

function failureView(result: ScenarioRunResult): ReportFailure | undefined {
  if (result.status !== 'failed') return undefined;
  const oracle = result.error.message.startsWith('Oracle safety violation:');
  return {
    code: oracle ? 'ORACLE_SAFETY_VIOLATION' : 'SCENARIO_EXECUTION_FAILED',
    message: oracle ? 'Oracle safety invariant failed.' : 'Scenario execution failed.',
  };
}

export function createReport(input: ReportInput): ReportDocument {
  const artifact = input.result.artifact;
  const failure = failureView(input.result);
  const componentVersions = {
    ...(artifact.componentVersions ?? {}),
    ...(input.componentVersions ?? {}),
  };
  const imageDigests = {
    ...(artifact.imageDigests ?? {}),
    ...(input.imageDigests ?? {}),
  };
  return {
    schemaVersion: 2,
    scenarioId: artifact.scenario,
    seed: artifact.seed,
    status: input.result.status,
    invariants: artifact.invariants.map(invariantView),
    commands: artifact.commands.map(commandView),
    timeline: artifact.history.map(timelineView),
    capabilities: capabilitiesView(artifact.capabilities),
    componentVersions: metadata(componentVersions, 'version'),
    imageDigests: metadata(imageDigests, 'digest'),
    ...(failure ? { failure } : {}),
  };
}
