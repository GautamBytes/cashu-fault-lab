import type { AdapterTransport, DurabilityLevel } from '@cashu-fault-lab/adapter-contract';
import { INVARIANT_REGISTRY, type InvariantId } from '@cashu-fault-lab/oracle';

export interface ReleaseSuiteEntry {
  readonly id: string;
  readonly scenario: string;
  readonly transports: readonly AdapterTransport[];
  readonly senderDurability: DurabilityLevel;
  readonly receiverDurability: DurabilityLevel;
  readonly requiredInvariants: readonly InvariantId[];
}

export interface ReleaseSuite {
  readonly schemaVersion: 1;
  readonly profile: string;
  readonly scenarios: readonly ReleaseSuiteEntry[];
}

const SUITE_KEYS = new Set(['schemaVersion', 'profile', 'scenarios']);
const ENTRY_KEYS = new Set([
  'id',
  'scenario',
  'transports',
  'senderDurability',
  'receiverDurability',
  'requiredInvariants',
]);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SCENARIO_PATH = /^scenarios\/[a-z0-9/_-]+\.json$/u;
const TRANSPORTS = new Set<AdapterTransport>(['http', 'nostr']);
const DURABILITY = new Set<DurabilityLevel>(['process', 'persistent', 'restart_safe']);
const INVARIANTS = new Set<InvariantId>(INVARIANT_REGISTRY.map(({ id }) => id));

function record(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>,
  subject: string,
): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !keys.has(key))) {
    throw new Error(`${subject} contains an unknown field`);
  }
  if (actual.length !== keys.size || [...keys].some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${subject} fields are invalid`);
  }
}

function durability(value: unknown): DurabilityLevel {
  if (typeof value !== 'string' || !DURABILITY.has(value as DurabilityLevel)) {
    throw new Error('Release suite scenario durability is invalid');
  }
  return value as DurabilityLevel;
}

function uniqueArray<T>(value: unknown, allowed: ReadonlySet<T>, subject: string): readonly T[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => !allowed.has(item as T)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${subject} are invalid`);
  }
  return value as readonly T[];
}

function releaseSuiteEntry(value: unknown): ReleaseSuiteEntry {
  const input = record(value, 'Release suite scenario must be an object');
  exactKeys(input, ENTRY_KEYS, 'Release suite scenario');
  if (typeof input.id !== 'string' || !ID.test(input.id)) {
    throw new Error('Release suite scenario id is invalid');
  }
  if (
    typeof input.scenario !== 'string' ||
    !SCENARIO_PATH.test(input.scenario) ||
    input.scenario.includes('//')
  ) {
    throw new Error('Release suite scenario path is invalid');
  }
  return {
    id: input.id,
    scenario: input.scenario,
    transports: uniqueArray(input.transports, TRANSPORTS, 'Release suite scenario transports'),
    senderDurability: durability(input.senderDurability),
    receiverDurability: durability(input.receiverDurability),
    requiredInvariants: uniqueArray(
      input.requiredInvariants,
      INVARIANTS,
      'Release suite scenario requiredInvariants',
    ),
  };
}

export function validateReleaseSuite(value: unknown): ReleaseSuite {
  const input = record(value, 'Release suite must be an object');
  exactKeys(input, SUITE_KEYS, 'Release suite');
  if (input.schemaVersion !== 1) {
    throw new Error('Release suite schemaVersion must be 1');
  }
  if (typeof input.profile !== 'string' || !ID.test(input.profile)) {
    throw new Error('Release suite profile is invalid');
  }
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) {
    throw new Error('Release suite scenarios must be a non-empty array');
  }
  const scenarios = input.scenarios.map(releaseSuiteEntry);
  const ids = scenarios.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Release suite contains a duplicate scenario id');
  }
  return {
    schemaVersion: 1,
    profile: input.profile,
    scenarios,
  };
}
