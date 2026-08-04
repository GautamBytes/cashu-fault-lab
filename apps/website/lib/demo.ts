import { readFile } from 'node:fs/promises';
import { resolveRepositoryPath } from './repository';

const INVARIANT_STATUSES = ['passed', 'failed', 'not_observable', 'not_applicable'] as const;

export type InvariantStatus = (typeof INVARIANT_STATUSES)[number];

export interface DemoInvariant {
  id: string;
  status: InvariantStatus;
  confidence: string;
  reason?: string;
}

interface EvidenceCheckCounts {
  checks: number;
  failed: number;
  warned: number;
}

interface EvidenceCleanupCounts {
  containers: number;
  networks: number;
  volumes: number;
}

export interface DemoVerification {
  release: string;
  package: string;
  command: string;
  publicationRunUrl: string;
  evidenceType: string;
  executedAt: string;
  environment: {
    platform: string;
    node: string;
    dockerClient: string;
    dockerServer: string;
  };
  doctor: EvidenceCheckCounts;
  cleanup: EvidenceCleanupCounts;
}

export interface DemoSummary {
  scenarioId: string;
  seed: string;
  status: string;
  commandCount: number;
  timelineCount: number;
  invariantCount: number;
  invariantCounts: Record<InvariantStatus, number>;
  invariants: DemoInvariant[];
  deliveryAttemptCount: number;
  redemptionStartCount: number;
  merchantCreditCount: number;
  verification: DemoVerification;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInvariantStatus(value: unknown): value is InvariantStatus {
  return typeof value === 'string' && (INVARIANT_STATUSES as readonly string[]).includes(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Demo artifact ${key} must be a string`);
  }
  return value;
}

function requiredArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`Demo artifact ${key} must be an array`);
  }
  return value;
}

function requiredRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Demo artifact ${key} must be an object`);
  }
  return value;
}

function requiredCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Demo artifact ${key} must be a non-negative integer`);
  }
  return value as number;
}

function parseInvariant(value: unknown): DemoInvariant {
  if (!isRecord(value) || !isInvariantStatus(value.status)) {
    throw new Error('Demo artifact contains an invalid invariant');
  }

  const reason = value.reason;
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error('Demo artifact invariant reason must be a string');
  }

  return {
    id: requiredString(value, 'id'),
    status: value.status,
    confidence: requiredString(value, 'confidence'),
    ...(reason === undefined ? {} : { reason }),
  };
}

function countTimelineEvent(timeline: unknown[], event: string): number {
  return timeline.filter((entry) => isRecord(entry) && entry.event === event).length;
}

function parseVerification(value: unknown): DemoVerification {
  if (!isRecord(value)) {
    throw new Error('Demo provenance must be an object');
  }
  const environment = requiredRecord(value, 'environment');
  const results = requiredRecord(value, 'results');
  const doctor = requiredRecord(results, 'doctor');
  const cleanup = requiredRecord(results, 'cleanup');

  return {
    release: requiredString(value, 'release'),
    package: requiredString(value, 'package'),
    command: requiredString(value, 'command'),
    publicationRunUrl: requiredString(value, 'publicationRunUrl'),
    evidenceType: requiredString(value, 'evidenceType'),
    executedAt: requiredString(value, 'executedAt'),
    environment: {
      platform: requiredString(environment, 'platform'),
      node: requiredString(environment, 'node'),
      dockerClient: requiredString(environment, 'dockerClient'),
      dockerServer: requiredString(environment, 'dockerServer'),
    },
    doctor: {
      checks: requiredCount(doctor, 'checks'),
      failed: requiredCount(doctor, 'failed'),
      warned: requiredCount(doctor, 'warned'),
    },
    cleanup: {
      containers: requiredCount(cleanup, 'containers'),
      networks: requiredCount(cleanup, 'networks'),
      volumes: requiredCount(cleanup, 'volumes'),
    },
  };
}

export async function getDemoSummary(): Promise<DemoSummary> {
  const [source, provenanceSource] = await Promise.all([
    readFile(resolveRepositoryPath('docs/examples/v0.2.0-demo.json'), 'utf8'),
    readFile(resolveRepositoryPath('docs/examples/v0.2.0-provenance.json'), 'utf8'),
  ]);
  const artifact: unknown = JSON.parse(source);
  const verification = parseVerification(JSON.parse(provenanceSource) as unknown);

  if (!isRecord(artifact) || artifact.schemaVersion !== 2) {
    throw new Error('Demo artifact must use schema version 2');
  }

  const commands = requiredArray(artifact, 'commands');
  const timeline = requiredArray(artifact, 'timeline');
  const invariants = requiredArray(artifact, 'invariants').map(parseInvariant);
  const invariantCounts: Record<InvariantStatus, number> = {
    passed: 0,
    failed: 0,
    not_observable: 0,
    not_applicable: 0,
  };

  for (const invariant of invariants) {
    invariantCounts[invariant.status] += 1;
  }

  return {
    scenarioId: requiredString(artifact, 'scenarioId'),
    seed: requiredString(artifact, 'seed'),
    status: requiredString(artifact, 'status'),
    commandCount: commands.length,
    timelineCount: timeline.length,
    invariantCount: invariants.length,
    invariantCounts,
    invariants,
    deliveryAttemptCount: countTimelineEvent(timeline, 'delivery_attempted'),
    redemptionStartCount: countTimelineEvent(timeline, 'redemption_started'),
    merchantCreditCount: countTimelineEvent(timeline, 'merchant_credited'),
    verification,
  };
}
