import { readFile } from 'node:fs/promises';
import { resolveRepositoryPath } from './repository';

export interface ReleaseStatus {
  label: 'Experimental developer preview';
  profile: string;
  policySchemaVersion: number;
  releaseSuiteScenarioCount: number;
  minimumQualifyingPairs: number;
  minimumDistinctMints: number;
  currentQualifyingPairs: 0;
  currentDistinctMints: 0;
  blockers: string[];
}

const BLOCKERS = [
  'Independent wallet receiver',
  'Independent mint and ledger evidence authorities',
  'Second qualifying implementation pair',
  'Second distinct mint identity',
  'External integration and review',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredInteger(record: Record<string, unknown>, key: string, sourceName: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${sourceName} ${key} must be a non-negative integer`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, sourceName: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${sourceName} ${key} must be a non-empty string`);
  }
  return value;
}

function requiredArray(
  record: Record<string, unknown>,
  key: string,
  sourceName: string,
): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${sourceName} ${key} must be an array`);
  }
  return value;
}

async function readJsonObject(path: string, sourceName: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(resolveRepositoryPath(path), 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${sourceName} must contain a JSON object`);
  }
  return parsed;
}

export async function getReleaseStatus(): Promise<ReleaseStatus> {
  const [policy, suite] = await Promise.all([
    readJsonObject('spec/release-policy.json', 'Release policy'),
    readJsonObject('spec/release-suite.json', 'Release suite'),
  ]);
  const policyProfile = requiredString(policy, 'profile', 'Release policy');
  const suiteProfile = requiredString(suite, 'profile', 'Release suite');

  if (policyProfile !== suiteProfile) {
    throw new Error('Release policy and release suite profiles must match');
  }

  return {
    label: 'Experimental developer preview',
    profile: policyProfile,
    policySchemaVersion: requiredInteger(policy, 'schemaVersion', 'Release policy'),
    releaseSuiteScenarioCount: requiredArray(suite, 'scenarios', 'Release suite').length,
    minimumQualifyingPairs: requiredInteger(policy, 'minimumQualifyingPairs', 'Release policy'),
    minimumDistinctMints: requiredInteger(policy, 'minimumDistinctMints', 'Release policy'),
    currentQualifyingPairs: 0,
    currentDistinctMints: 0,
    blockers: [...BLOCKERS],
  };
}
