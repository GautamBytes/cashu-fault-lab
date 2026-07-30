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

export interface DemoSummary {
  scenarioId: string;
  seed: string;
  status: string;
  commandCount: number;
  timelineCount: number;
  invariantCount: number;
  invariantCounts: Record<InvariantStatus, number>;
  invariants: DemoInvariant[];
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

export async function getDemoSummary(): Promise<DemoSummary> {
  const source = await readFile(resolveRepositoryPath('docs/examples/v0.1.2-demo.json'), 'utf8');
  const artifact: unknown = JSON.parse(source);

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
  };
}
