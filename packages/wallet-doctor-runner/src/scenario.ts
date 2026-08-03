import { createHash } from 'node:crypto';

export interface WalletDoctorScenarioStep {
  readonly op: 'mint' | 'spend' | 'relay-partition' | 'relay-heal';
  /** mint/spend: positive sat amount. */
  readonly amount?: number;
  /** spend: publish fault mode. */
  readonly mode?: string;
  /** relay-partition/relay-heal: zero-based relay index. */
  readonly relay?: number;
  /** relay-partition: withheld event ids/kinds/authors (kinds typical). */
  readonly eventIds?: readonly string[];
  readonly kinds?: readonly number[];
  readonly authors?: readonly string[];
}

export interface WalletDoctorScenarioExpect {
  /** Exact expected set of diagnosis codes (sorted). */
  readonly codes: readonly string[];
  /** Expected `diagnosis.ok` (false when error findings are expected). */
  readonly ok: boolean;
  readonly doubleCounted?: number;
  readonly mintVerified?: number;
  readonly merged?: number;
  readonly ghost?: number;
  readonly orphanedUnspent?: number;
}

export interface WalletDoctorScenario {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly commands: readonly WalletDoctorScenarioStep[];
  readonly expect: WalletDoctorScenarioExpect;
}

const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SPEND_MODES = new Set(['clean', 'partial-delete', 'partial-publish', 'ghost', 'delete-only']);
const EXPECTED_CODES = new Set([
  'RELAY_PARTITION',
  'GHOST_TOKEN',
  'ORPHANED_PROOFS',
  'DEL_CHAIN_BREAK',
  'WALLET_EVENT_FORK',
  'DELETION_NOT_PROPAGATED',
  'HISTORY_GAP',
  'QUOTE_LIMBO',
  'MALFORMED_EVENT',
]);

function fail(message: string): never {
  throw new Error(`wallet-doctor scenario is invalid: ${message}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail(`${name} must be a positive integer`);
  return value as number;
}

function relayIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('relay must be a zero-based relay index');
  }
  return value as number;
}

function stringArray64(value: unknown, name: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && /^[0-9a-f]{64}$/u.test(item))
  ) {
    fail(`${name} must be an array of 64-hex strings`);
  }
  return value as readonly string[];
}

function validateStep(value: unknown, index: number): WalletDoctorScenarioStep {
  if (!isRecord(value)) fail(`step ${index} must be an object`);
  if (value.op === 'mint') {
    return { op: 'mint', amount: positiveInt(value.amount, `step ${index} amount`) };
  }
  if (value.op === 'spend') {
    if (typeof value.mode !== 'string' || !SPEND_MODES.has(value.mode)) {
      fail(`step ${index} mode must be one of ${[...SPEND_MODES].join(', ')}`);
    }
    return {
      op: 'spend',
      amount: positiveInt(value.amount, `step ${index} amount`),
      mode: value.mode,
    };
  }
  if (value.op === 'relay-partition' || value.op === 'relay-heal') {
    const step: WalletDoctorScenarioStep = { op: value.op, relay: relayIndex(value.relay) };
    if (value.op === 'relay-heal') return step;
    const eventIds = value.eventIds === undefined ? [] : stringArray64(value.eventIds, 'eventIds');
    const authors = value.authors === undefined ? [] : stringArray64(value.authors, 'authors');
    const kinds = value.kinds === undefined ? [] : value.kinds;
    if (
      !Array.isArray(kinds) ||
      !kinds.every(
        (kind) => Number.isSafeInteger(kind) && (kind as number) >= 0 && (kind as number) <= 65_535,
      )
    ) {
      fail(`step ${index} kinds must be an array of event kind numbers`);
    }
    if (eventIds.length === 0 && authors.length === 0 && (kinds as number[]).length === 0) {
      fail(`step ${index} relay-partition must withhold at least one id, kind, or author`);
    }
    return { ...step, eventIds, kinds: kinds as number[], authors };
  }
  return fail(`step ${index} op must be mint, spend, relay-partition, or relay-heal`);
}

/** Validate an unknown value as a wallet-doctor scenario spec. */
export function validateWalletDoctorScenario(value: unknown): WalletDoctorScenario {
  if (!isRecord(value)) fail('spec must be an object');
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof value.id !== 'string' || !SCENARIO_ID_PATTERN.test(value.id)) {
    fail('id must be a lowercase kebab-case identifier');
  }
  if (typeof value.name !== 'string' || value.name.length < 1) fail('name is required');
  if (typeof value.description !== 'string' || value.description.length < 1) {
    fail('description is required');
  }
  if (!Array.isArray(value.commands) || value.commands.length === 0)
    fail('commands must be a non-empty array');
  const commands = value.commands.map((step, index) => validateStep(step, index));
  if (!isRecord(value.expect)) fail('expect must be an object');
  if (
    !Array.isArray(value.expect.codes) ||
    !value.expect.codes.every((code) => typeof code === 'string' && EXPECTED_CODES.has(code))
  ) {
    fail('expect.codes must list known diagnosis codes');
  }
  if (typeof value.expect.ok !== 'boolean') fail('expect.ok must be boolean');
  const numeric = (name: string): number | undefined => {
    const field = (value.expect as Record<string, unknown>)[name];
    if (field === undefined) return undefined;
    if (!Number.isSafeInteger(field) || (field as number) < 0)
      fail(`expect.${name} must be a non-negative integer`);
    return field as number;
  };
  const expectOut: {
    codes: string[];
    ok: boolean;
    doubleCounted?: number;
    mintVerified?: number;
    merged?: number;
    ghost?: number;
    orphanedUnspent?: number;
  } = { codes: [...(value.expect.codes as string[])].sort(), ok: value.expect.ok };
  for (const field of [
    'doubleCounted',
    'mintVerified',
    'merged',
    'ghost',
    'orphanedUnspent',
  ] as const) {
    const parsed = numeric(field);
    if (parsed !== undefined) expectOut[field] = parsed;
  }
  const scenario: WalletDoctorScenario = {
    schemaVersion: 1,
    id: value.id,
    name: value.name,
    description: value.description,
    commands,
    expect: expectOut,
  };
  return scenario;
}

const SEED_HASH_DOMAIN = 'cashu-fault-lab/nip60-doctor-seed-v1';

/** Domain-separated seed hash; artifacts carry the hash, never the raw seed. */
export function doctorSeedHash(seed: string): string {
  return createHash('sha256').update(`${SEED_HASH_DOMAIN}\0${seed}`, 'utf8').digest('hex');
}
