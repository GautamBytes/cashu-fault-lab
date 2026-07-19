import type {
  FailureArtifact,
  HistoryEvent,
  ScenarioCommand,
  ScenarioRunResult,
} from '@cashu-fault-lab/scenario-runner';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const METADATA_KEY_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$/;

export interface ReportInput {
  readonly result: ScenarioRunResult;
  readonly componentVersions?: Readonly<Record<string, string>>;
  readonly imageDigests?: Readonly<Record<string, string>>;
}

export interface ReportInvariant {
  readonly name: 'scenario-conformance';
  readonly passed: boolean;
}

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

export interface ReportCapabilities {
  readonly implementation?: string;
  readonly version?: string;
  readonly nuts?: readonly number[];
  readonly transports?: readonly string[];
  readonly evidenceTier?: string;
  readonly sender?: string;
  readonly receiver?: string;
}

export interface ReportDocument {
  readonly schemaVersion: 1;
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

function capabilitiesView(value: FailureArtifact['capabilities']): ReportCapabilities {
  const implementation = stringField(value.implementation);
  const version = stringField(value.version);
  const evidenceTier = stringField(value.evidenceTier);
  const sender = stringField(value.sender);
  const receiver = stringField(value.receiver);
  const nuts = Array.isArray(value.nuts)
    ? value.nuts.filter((item): item is number => Number.isSafeInteger(item) && Number(item) >= 0)
    : undefined;
  const transports = Array.isArray(value.transports)
    ? value.transports.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    ...(implementation ? { implementation } : {}),
    ...(version ? { version } : {}),
    ...(nuts ? { nuts } : {}),
    ...(transports ? { transports } : {}),
    ...(evidenceTier ? { evidenceTier } : {}),
    ...(sender ? { sender } : {}),
    ...(receiver ? { receiver } : {}),
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
  return {
    schemaVersion: 1,
    scenarioId: artifact.scenario,
    seed: artifact.seed,
    status: input.result.status,
    invariants: [{ name: 'scenario-conformance', passed: input.result.status === 'passed' }],
    commands: artifact.commands.map(commandView),
    timeline: artifact.history.map(timelineView),
    capabilities: capabilitiesView(artifact.capabilities),
    componentVersions: metadata(input.componentVersions, 'version'),
    imageDigests: metadata(input.imageDigests, 'digest'),
    ...(failure ? { failure } : {}),
  };
}
