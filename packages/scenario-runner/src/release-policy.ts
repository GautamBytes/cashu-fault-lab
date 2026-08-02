import { isDevelopmentIdentity, type EvidenceTier } from '@cashu-fault-lab/adapter-contract';
import {
  INVARIANT_REGISTRY,
  type EvidenceConfidence,
  type InvariantId,
} from '@cashu-fault-lab/oracle';
import type { MatrixCaseResult } from './matrix.js';
import { createHash } from 'node:crypto';

export interface ReleasePolicy {
  readonly schemaVersion: 3;
  readonly releaseSuiteDigest: string;
  readonly profile: string;
  readonly minimumQualifyingPairs: number;
  readonly requireCrossImplementation: boolean;
  readonly requireCrossLanguage: boolean;
  readonly requireDistinctBuilds: boolean;
  readonly minimumDistinctMints: number;
  readonly minimumEvidence: {
    readonly sender: EvidenceTier;
    readonly receiver: EvidenceTier;
  };
  readonly requiredInvariants: readonly InvariantId[];
  readonly requiredScenarios: readonly string[];
  readonly acceptedConfidence: readonly EvidenceConfidence[];
}

export type ReleaseGateReasonCode =
  | 'CROSS_IMPLEMENTATION_REQUIRED'
  | 'CROSS_LANGUAGE_REQUIRED'
  | 'DISTINCT_BUILD_REQUIRED'
  | 'SENDER_EVIDENCE_TOO_LOW'
  | 'RECEIVER_EVIDENCE_TOO_LOW'
  | 'MINT_IDENTITY_REQUIRED'
  | 'REQUIRED_SCENARIO_MISSING'
  | 'REQUIRED_SCENARIO_NOT_PASSED'
  | 'REQUIRED_INVARIANT_MISSING'
  | 'REQUIRED_INVARIANT_NOT_PASSED'
  | 'INVARIANT_CONFIDENCE_REJECTED'
  | 'DEVELOPMENT_IDENTITY_NOT_RELEASE_ELIGIBLE'
  | 'DUPLICATE_PROVENANCE'
  | 'MINIMUM_QUALIFYING_PAIRS'
  | 'MINIMUM_DISTINCT_MINTS'
  | 'RELEASE_SUITE_DIGEST_MISMATCH';

export interface ReleaseGateReason {
  readonly code: ReleaseGateReasonCode;
  readonly message: string;
  readonly pair?: string;
  readonly scenario?: string;
}

export interface ReleaseGateResult {
  readonly passed: boolean;
  readonly qualifyingPairs: readonly string[];
  readonly reasons: readonly ReleaseGateReason[];
}

const POLICY_KEYS = new Set([
  'schemaVersion',
  'releaseSuiteDigest',
  'profile',
  'minimumQualifyingPairs',
  'requireCrossImplementation',
  'requireCrossLanguage',
  'requireDistinctBuilds',
  'minimumDistinctMints',
  'minimumEvidence',
  'requiredInvariants',
  'requiredScenarios',
  'acceptedConfidence',
]);
const EVIDENCE_KEYS = new Set(['sender', 'receiver']);
const TIERS = new Set<EvidenceTier>(['T0', 'T1', 'T2', 'T3']);
const CONFIDENCE = new Set<EvidenceConfidence>(['observed', 'derived']);
const INVARIANT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const INVARIANTS = new Set(INVARIANT_REGISTRY.map(({ id }) => id));
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function record(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>,
  message: string,
): void {
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error(message);
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return Number(value);
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function tier(value: unknown, name: string): EvidenceTier {
  if (typeof value !== 'string' || !TIERS.has(value as EvidenceTier)) {
    throw new Error(`${name} must be an evidence tier`);
  }
  return value as EvidenceTier;
}

export function validateReleasePolicy(value: unknown): ReleasePolicy {
  const input = record(value, 'Release policy must be an object');
  exactKeys(input, POLICY_KEYS, 'Release policy contains an unknown field');
  if (input.schemaVersion !== 3) throw new Error('Release policy schemaVersion must be 3');
  if (typeof input.releaseSuiteDigest !== 'string' || !DIGEST.test(input.releaseSuiteDigest)) {
    throw new Error('Release policy releaseSuiteDigest is invalid');
  }
  if (typeof input.profile !== 'string' || !INVARIANT_ID.test(input.profile)) {
    throw new Error('Release policy profile is invalid');
  }
  const evidence = record(
    input.minimumEvidence,
    'Release policy minimumEvidence must be an object',
  );
  exactKeys(evidence, EVIDENCE_KEYS, 'Release policy minimumEvidence contains an unknown field');
  if (
    !Array.isArray(input.requiredInvariants) ||
    input.requiredInvariants.length === 0 ||
    input.requiredInvariants.some(
      (id) =>
        typeof id !== 'string' || !INVARIANT_ID.test(id) || !INVARIANTS.has(id as InvariantId),
    ) ||
    new Set(input.requiredInvariants).size !== input.requiredInvariants.length
  ) {
    throw new Error('Release policy requiredInvariants are invalid');
  }
  if (
    !Array.isArray(input.requiredScenarios) ||
    input.requiredScenarios.length === 0 ||
    input.requiredScenarios.some((id) => typeof id !== 'string' || !INVARIANT_ID.test(id)) ||
    new Set(input.requiredScenarios).size !== input.requiredScenarios.length
  ) {
    throw new Error('Release policy requiredScenarios are invalid');
  }
  if (
    !Array.isArray(input.acceptedConfidence) ||
    input.acceptedConfidence.length === 0 ||
    input.acceptedConfidence.some(
      (item) => typeof item !== 'string' || !CONFIDENCE.has(item as EvidenceConfidence),
    ) ||
    new Set(input.acceptedConfidence).size !== input.acceptedConfidence.length
  ) {
    throw new Error('Release policy acceptedConfidence is invalid');
  }
  return {
    schemaVersion: 3,
    releaseSuiteDigest: input.releaseSuiteDigest,
    profile: input.profile,
    minimumQualifyingPairs: nonnegativeInteger(
      input.minimumQualifyingPairs,
      'minimumQualifyingPairs',
    ),
    requireCrossImplementation: boolean(
      input.requireCrossImplementation,
      'requireCrossImplementation',
    ),
    requireCrossLanguage: boolean(input.requireCrossLanguage, 'requireCrossLanguage'),
    requireDistinctBuilds: boolean(input.requireDistinctBuilds, 'requireDistinctBuilds'),
    minimumDistinctMints: nonnegativeInteger(input.minimumDistinctMints, 'minimumDistinctMints'),
    minimumEvidence: {
      sender: tier(evidence.sender, 'minimumEvidence.sender'),
      receiver: tier(evidence.receiver, 'minimumEvidence.receiver'),
    },
    requiredInvariants: input.requiredInvariants as readonly InvariantId[],
    requiredScenarios: input.requiredScenarios as readonly string[],
    acceptedConfidence: input.acceptedConfidence as readonly EvidenceConfidence[],
  };
}

const TIER_RANK: Readonly<Record<EvidenceTier, number>> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

function provenanceKey(selected: Extract<MatrixCaseResult, { readonly status: 'passed' }>): string {
  const sender = selected.senderCapabilities.implementation;
  const receiver = selected.receiverCapabilities.implementation;
  const mints = [...selected.mints]
    .map((mint) => `${mint.id}:${mint.implementation}:${mint.version ?? ''}`)
    .sort()
    .join(',');
  return [
    sender.sourceDigest,
    sender.buildDigest,
    receiver.sourceDigest,
    receiver.buildDigest,
    mints,
  ].join('|');
}

function mintKey(mint: {
  readonly id: string;
  readonly implementation: string;
  readonly version?: string;
}): string {
  return `${mint.id}:${mint.implementation}:${mint.version ?? ''}`;
}

function pairReasons(
  policy: ReleasePolicy,
  selected: Extract<MatrixCaseResult, { readonly status: 'passed' }>,
): readonly ReleaseGateReason[] {
  const pair = `${selected.sender}->${selected.receiver}`;
  const sender = selected.senderCapabilities;
  const receiver = selected.receiverCapabilities;
  const reasons: ReleaseGateReason[] = [];
  const add = (code: ReleaseGateReasonCode, message: string): void => {
    reasons.push({ code, message, pair });
  };

  if (
    isDevelopmentIdentity(sender.implementation) ||
    isDevelopmentIdentity(receiver.implementation)
  ) {
    add(
      'DEVELOPMENT_IDENTITY_NOT_RELEASE_ELIGIBLE',
      'Release evidence requires source and build digests from produced artifacts.',
    );
  }
  if (
    policy.requireCrossImplementation &&
    sender.implementation.id === receiver.implementation.id
  ) {
    add('CROSS_IMPLEMENTATION_REQUIRED', 'Sender and receiver implementations must differ.');
  }
  if (
    policy.requireCrossLanguage &&
    sender.implementation.language === receiver.implementation.language
  ) {
    add('CROSS_LANGUAGE_REQUIRED', 'Sender and receiver implementation languages must differ.');
  }
  if (
    policy.requireDistinctBuilds &&
    sender.implementation.sourceDigest === receiver.implementation.sourceDigest &&
    sender.implementation.buildDigest === receiver.implementation.buildDigest
  ) {
    add(
      'DISTINCT_BUILD_REQUIRED',
      'Sender and receiver must use distinct source/build identities.',
    );
  }

  const senderTier = sender.roles.sender?.evidence.tier;
  if (
    senderTier === undefined ||
    TIER_RANK[senderTier] < TIER_RANK[policy.minimumEvidence.sender]
  ) {
    add('SENDER_EVIDENCE_TOO_LOW', `Sender evidence must meet ${policy.minimumEvidence.sender}.`);
  }
  const receiverTier = receiver.roles.receiver?.evidence.tier;
  if (
    receiverTier === undefined ||
    TIER_RANK[receiverTier] < TIER_RANK[policy.minimumEvidence.receiver]
  ) {
    add(
      'RECEIVER_EVIDENCE_TOO_LOW',
      `Receiver evidence must meet ${policy.minimumEvidence.receiver}.`,
    );
  }
  if (selected.mints.length === 0) {
    add('MINT_IDENTITY_REQUIRED', 'A configured mint identity is required.');
  }
  if (selected.releaseSuiteDigest !== policy.releaseSuiteDigest) {
    add(
      'RELEASE_SUITE_DIGEST_MISMATCH',
      'Matrix evidence was not produced by the release suite bound to this policy.',
    );
  }

  const addScenarioInvariantReason = (
    code: ReleaseGateReasonCode,
    scenario: string,
    message: string,
  ): void => {
    reasons.push({ code, message, pair, scenario });
  };

  for (const id of policy.requiredScenarios) {
    const matches = selected.scenarios.filter((scenario) => scenario.id === id);
    if (matches.length === 0) {
      reasons.push({
        code: 'REQUIRED_SCENARIO_MISSING',
        message: `Required scenario ${id} is missing for ${pair}.`,
        pair,
        scenario: id,
      });
      continue;
    }
    const result = matches[0]!;
    if (matches.length !== 1 || result.status !== 'passed') {
      reasons.push({
        code: 'REQUIRED_SCENARIO_NOT_PASSED',
        message:
          matches.length === 1
            ? `Required scenario ${id} has status ${result.status} for ${pair}.`
            : `Required scenario ${id} does not have unique passing evidence for ${pair}.`,
        pair,
        scenario: id,
      });
      continue;
    }
    const scenarioInvariants = new Map(
      result.invariants.map((invariant) => [invariant.id, invariant]),
    );
    for (const invariantId of result.requiredInvariants) {
      const invariant = scenarioInvariants.get(invariantId);
      if (invariant === undefined) {
        addScenarioInvariantReason(
          'REQUIRED_INVARIANT_MISSING',
          id,
          `Required scenario ${id} is missing invariant ${invariantId} for ${pair}.`,
        );
        continue;
      }
      if (invariant.status !== 'passed') {
        addScenarioInvariantReason(
          'REQUIRED_INVARIANT_NOT_PASSED',
          id,
          `Required scenario ${id} invariant ${invariantId} has status ${invariant.status} for ${pair}.`,
        );
        continue;
      }
      if (!policy.acceptedConfidence.includes(invariant.confidence)) {
        addScenarioInvariantReason(
          'INVARIANT_CONFIDENCE_REJECTED',
          id,
          `Required scenario ${id} invariant ${invariantId} has rejected confidence ${invariant.confidence} for ${pair}.`,
        );
      }
    }
  }

  const invariants = new Map(selected.invariants.map((result) => [result.id, result]));
  for (const id of policy.requiredInvariants) {
    const result = invariants.get(id);
    if (result === undefined) {
      add('REQUIRED_INVARIANT_MISSING', `Required invariant ${id} is missing.`);
      continue;
    }
    if (result.status !== 'passed') {
      add('REQUIRED_INVARIANT_NOT_PASSED', `Required invariant ${id} has status ${result.status}.`);
      continue;
    }
    if (!policy.acceptedConfidence.includes(result.confidence)) {
      add(
        'INVARIANT_CONFIDENCE_REJECTED',
        `Required invariant ${id} has rejected confidence ${result.confidence}.`,
      );
    }
  }
  return reasons;
}

function sortReasons(reasons: readonly ReleaseGateReason[]): readonly ReleaseGateReason[] {
  return [...reasons].sort((left, right) => {
    const pair = (left.pair ?? '').localeCompare(right.pair ?? '');
    if (pair !== 0) return pair;
    const code = left.code.localeCompare(right.code);
    return code === 0 ? (left.scenario ?? '').localeCompare(right.scenario ?? '') : code;
  });
}

export function evaluateReleasePolicy(
  policyInput: ReleasePolicy,
  cases: readonly MatrixCaseResult[],
): ReleaseGateResult {
  const policy = validateReleasePolicy(policyInput);
  const passedCases = cases
    .filter(
      (selected): selected is Extract<MatrixCaseResult, { readonly status: 'passed' }> =>
        selected.status === 'passed' && selected.profile === policy.profile,
    )
    .sort((left, right) =>
      `${left.sender}->${left.receiver}`.localeCompare(`${right.sender}->${right.receiver}`),
    );
  const reasons: ReleaseGateReason[] = [];
  const qualifying: Extract<MatrixCaseResult, { readonly status: 'passed' }>[] = [];
  const seen = new Set<string>();

  for (const selected of passedCases) {
    const rejected = pairReasons(policy, selected);
    reasons.push(...rejected);
    if (rejected.length > 0) continue;
    const provenance = provenanceKey(selected);
    if (seen.has(provenance)) {
      reasons.push({
        code: 'DUPLICATE_PROVENANCE',
        message: 'This pair aliases an already-counted source/build/mint provenance.',
        pair: `${selected.sender}->${selected.receiver}`,
      });
      continue;
    }
    seen.add(provenance);
    qualifying.push(selected);
  }

  if (qualifying.length < policy.minimumQualifyingPairs) {
    reasons.push({
      code: 'MINIMUM_QUALIFYING_PAIRS',
      message: `Release requires ${policy.minimumQualifyingPairs} qualifying pairs; observed ${qualifying.length}.`,
    });
  }
  const distinctMints = new Set(qualifying.flatMap((selected) => selected.mints.map(mintKey)));
  if (distinctMints.size < policy.minimumDistinctMints) {
    reasons.push({
      code: 'MINIMUM_DISTINCT_MINTS',
      message: `Release requires ${policy.minimumDistinctMints} distinct mints; observed ${distinctMints.size}.`,
    });
  }

  const sorted = sortReasons(reasons);
  return {
    passed: sorted.length === 0,
    qualifyingPairs: qualifying
      .map((selected) => `${selected.sender}->${selected.receiver}`)
      .sort(),
    reasons: sorted,
  };
}

export interface LifecycleReleaseSuite {
  readonly schemaVersion: 1;
  readonly profile: 'wallet-lifecycle-v1';
  readonly releaseSuiteDigest: string;
  readonly minimumWalletImplementations: number;
  readonly minimumMintImplementations: number;
  readonly requireCrossLanguage: true;
  readonly requireDistinctBuilds: true;
  readonly requireReplayEvidence: true;
  readonly allowSkippedRequired: false;
  readonly requiredOperations: readonly string[];
  readonly requiredScenarios: readonly string[];
  readonly requiredInvariants: readonly string[];
}

export interface LifecycleReleaseEvidence {
  readonly wallet: {
    readonly id: string;
    readonly language: string;
    readonly sourceDigest: string;
    readonly buildDigest: string;
  };
  readonly mint: {
    readonly id: string;
    readonly implementation: string;
    readonly version?: string;
  };
  readonly operations: readonly string[];
  readonly releaseSuiteDigest: string;
  readonly secretScanPassed: boolean;
  readonly scenarios: readonly {
    readonly id: string;
    readonly status: 'passed' | 'failed' | 'not_applicable' | 'skipped';
    readonly replayDigest?: string;
    readonly invariants: readonly {
      readonly id: string;
      readonly status: 'passed' | 'failed' | 'not_applicable' | 'skipped';
    }[];
  }[];
}

export type LifecycleReleaseReasonCode =
  | 'LIFECYCLE_EVIDENCE_INVALID'
  | 'LIFECYCLE_POLICY_MISMATCH'
  | 'LIFECYCLE_MINIMUM_WALLETS'
  | 'LIFECYCLE_MINIMUM_MINTS'
  | 'LIFECYCLE_CROSS_LANGUAGE'
  | 'LIFECYCLE_DISTINCT_BUILD'
  | 'LIFECYCLE_OPERATION_MISSING'
  | 'LIFECYCLE_REQUIRED_SCENARIO'
  | 'LIFECYCLE_REQUIRED_INVARIANT'
  | 'LIFECYCLE_REPLAY_REQUIRED'
  | 'LIFECYCLE_SECRET_SCAN';

export interface LifecycleReleaseResult {
  readonly passed: boolean;
  readonly reasons: readonly {
    readonly code: LifecycleReleaseReasonCode;
    readonly message: string;
    readonly participant?: string;
    readonly scenario?: string;
  }[];
}

const LIFECYCLE_SUITE_KEYS = new Set([
  'schemaVersion',
  'profile',
  'releaseSuiteDigest',
  'minimumWalletImplementations',
  'minimumMintImplementations',
  'requireCrossLanguage',
  'requireDistinctBuilds',
  'requireReplayEvidence',
  'allowSkippedRequired',
  'requiredOperations',
  'requiredScenarios',
  'requiredInvariants',
]);
const LIFECYCLE_OPERATIONS = new Set([
  'mint',
  'swap',
  'send',
  'receive',
  'melt',
  'restore',
  'reconcile',
]);
const LIFECYCLE_STATUSES = new Set(['passed', 'failed', 'not_applicable', 'skipped']);

function lifecycleIdentifierArray(
  value: unknown,
  name: string,
  allowed?: ReadonlySet<string>,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) =>
        typeof item !== 'string' || !INVARIANT_ID.test(item) || (allowed && !allowed.has(item)),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`Lifecycle release suite ${name} is invalid`);
  }
  return value as readonly string[];
}

export function validateLifecycleReleaseSuite(value: unknown): LifecycleReleaseSuite {
  const input = record(value, 'Lifecycle release suite must be an object');
  exactKeys(input, LIFECYCLE_SUITE_KEYS, 'Lifecycle release suite contains an unknown field');
  if (input.schemaVersion !== 1) throw new Error('Lifecycle release suite schemaVersion must be 1');
  if (input.profile !== 'wallet-lifecycle-v1') {
    throw new Error('Lifecycle release suite profile is invalid');
  }
  if (typeof input.releaseSuiteDigest !== 'string' || !DIGEST.test(input.releaseSuiteDigest)) {
    throw new Error('Lifecycle release suite digest is invalid');
  }
  const minimumWalletImplementations = nonnegativeInteger(
    input.minimumWalletImplementations,
    'minimumWalletImplementations',
  );
  const minimumMintImplementations = nonnegativeInteger(
    input.minimumMintImplementations,
    'minimumMintImplementations',
  );
  if (minimumWalletImplementations < 2 || minimumMintImplementations < 2) {
    throw new Error('Lifecycle release suite requires two wallet and mint implementations');
  }
  if (input.requireCrossLanguage !== true) {
    throw new Error('Lifecycle release suite requireCrossLanguage must be true');
  }
  if (input.requireDistinctBuilds !== true) {
    throw new Error('Lifecycle release suite requireDistinctBuilds must be true');
  }
  if (input.requireReplayEvidence !== true) {
    throw new Error('Lifecycle release suite requireReplayEvidence must be true');
  }
  if (input.allowSkippedRequired !== false) {
    throw new Error('Lifecycle release suite allowSkippedRequired must be false');
  }
  const requiredOperations = lifecycleIdentifierArray(
    input.requiredOperations,
    'requiredOperations',
    LIFECYCLE_OPERATIONS,
  );
  if (requiredOperations.length !== LIFECYCLE_OPERATIONS.size) {
    throw new Error('Lifecycle release suite must require every lifecycle operation');
  }
  const requiredScenarios = lifecycleIdentifierArray(input.requiredScenarios, 'requiredScenarios');
  const requiredInvariants = lifecycleIdentifierArray(
    input.requiredInvariants,
    'requiredInvariants',
  );
  const digestInput = JSON.stringify({
    schemaVersion: 1,
    profile: 'wallet-lifecycle-v1',
    minimumWalletImplementations,
    minimumMintImplementations,
    requireCrossLanguage: true,
    requireDistinctBuilds: true,
    requireReplayEvidence: true,
    allowSkippedRequired: false,
    requiredOperations,
    requiredScenarios,
    requiredInvariants,
  });
  const expectedDigest = `sha256:${createHash('sha256')
    .update('cashu-fault-lab/wallet-lifecycle-release-suite/v1\0')
    .update(digestInput)
    .digest('hex')}`;
  if (input.releaseSuiteDigest !== expectedDigest) {
    throw new Error('Lifecycle release suite digest does not bind its exact requirements');
  }
  return {
    schemaVersion: 1,
    profile: 'wallet-lifecycle-v1',
    releaseSuiteDigest: input.releaseSuiteDigest,
    minimumWalletImplementations,
    minimumMintImplementations,
    requireCrossLanguage: true,
    requireDistinctBuilds: true,
    requireReplayEvidence: true,
    allowSkippedRequired: false,
    requiredOperations,
    requiredScenarios,
    requiredInvariants,
  };
}

function lifecycleExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function validLifecycleEvidence(value: unknown): value is LifecycleReleaseEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const input = value as Readonly<Record<string, unknown>>;
  if (
    !lifecycleExactKeys(input, [
      'wallet',
      'mint',
      'operations',
      'releaseSuiteDigest',
      'secretScanPassed',
      'scenarios',
    ]) ||
    typeof input.wallet !== 'object' ||
    input.wallet === null ||
    Array.isArray(input.wallet) ||
    typeof input.mint !== 'object' ||
    input.mint === null ||
    Array.isArray(input.mint)
  ) {
    return false;
  }
  const wallet = input.wallet as Readonly<Record<string, unknown>>;
  const mint = input.mint as Readonly<Record<string, unknown>>;
  if (
    !lifecycleExactKeys(wallet, ['id', 'language', 'sourceDigest', 'buildDigest']) ||
    !lifecycleExactKeys(
      mint,
      Reflect.has(mint, 'version') ? ['id', 'implementation', 'version'] : ['id', 'implementation'],
    ) ||
    typeof wallet.id !== 'string' ||
    !INVARIANT_ID.test(wallet.id) ||
    typeof wallet.language !== 'string' ||
    !INVARIANT_ID.test(wallet.language) ||
    typeof wallet.sourceDigest !== 'string' ||
    !DIGEST.test(wallet.sourceDigest) ||
    typeof wallet.buildDigest !== 'string' ||
    !DIGEST.test(wallet.buildDigest) ||
    typeof mint.id !== 'string' ||
    !INVARIANT_ID.test(mint.id) ||
    typeof mint.implementation !== 'string' ||
    !INVARIANT_ID.test(mint.implementation) ||
    (mint.version !== undefined &&
      (typeof mint.version !== 'string' || mint.version.length < 1 || mint.version.length > 128)) ||
    typeof input.releaseSuiteDigest !== 'string' ||
    !DIGEST.test(input.releaseSuiteDigest) ||
    typeof input.secretScanPassed !== 'boolean' ||
    !Array.isArray(input.operations) ||
    input.operations.length === 0 ||
    input.operations.some(
      (operation) => typeof operation !== 'string' || !LIFECYCLE_OPERATIONS.has(operation),
    ) ||
    new Set(input.operations).size !== input.operations.length ||
    !Array.isArray(input.scenarios)
  ) {
    return false;
  }
  return input.scenarios.every((scenario) => {
    if (typeof scenario !== 'object' || scenario === null || Array.isArray(scenario)) return false;
    const selected = scenario as Readonly<Record<string, unknown>>;
    const scenarioKeys = Reflect.has(selected, 'replayDigest')
      ? ['id', 'status', 'replayDigest', 'invariants']
      : ['id', 'status', 'invariants'];
    if (
      !lifecycleExactKeys(selected, scenarioKeys) ||
      typeof selected.id !== 'string' ||
      !INVARIANT_ID.test(selected.id) ||
      typeof selected.status !== 'string' ||
      !LIFECYCLE_STATUSES.has(selected.status) ||
      (selected.replayDigest !== undefined &&
        (typeof selected.replayDigest !== 'string' || !DIGEST.test(selected.replayDigest))) ||
      !Array.isArray(selected.invariants)
    ) {
      return false;
    }
    return selected.invariants.every((invariant) => {
      if (typeof invariant !== 'object' || invariant === null || Array.isArray(invariant)) {
        return false;
      }
      const result = invariant as Readonly<Record<string, unknown>>;
      return (
        lifecycleExactKeys(result, ['id', 'status']) &&
        typeof result.id === 'string' &&
        INVARIANT_ID.test(result.id) &&
        typeof result.status === 'string' &&
        LIFECYCLE_STATUSES.has(result.status)
      );
    });
  });
}

export function evaluateLifecycleReleaseSuite(
  suiteInput: LifecycleReleaseSuite,
  evidence: readonly LifecycleReleaseEvidence[],
): LifecycleReleaseResult {
  const suite = validateLifecycleReleaseSuite(suiteInput);
  const reasons: Array<LifecycleReleaseResult['reasons'][number]> = [];
  const acceptedEvidence: LifecycleReleaseEvidence[] = [];
  const participantKeys = new Set<string>();
  const walletIdentities = new Map<string, string>();
  const mintIdentities = new Map<string, string>();
  for (const [index, participant] of evidence.entries()) {
    if (!validLifecycleEvidence(participant)) {
      reasons.push({
        code: 'LIFECYCLE_EVIDENCE_INVALID',
        message: 'Lifecycle evidence is malformed or contains unrecognized fields.',
        participant: `evidence-${index + 1}`,
      });
      continue;
    }
    const participantId = `${participant.wallet.id}@${participant.mint.id}`;
    const walletIdentity = `${participant.wallet.language}:${participant.wallet.sourceDigest}:${participant.wallet.buildDigest}`;
    const mintIdentity = `${participant.mint.implementation}:${participant.mint.version ?? ''}`;
    if (
      participantKeys.has(participantId) ||
      (walletIdentities.has(participant.wallet.id) &&
        walletIdentities.get(participant.wallet.id) !== walletIdentity) ||
      (mintIdentities.has(participant.mint.id) &&
        mintIdentities.get(participant.mint.id) !== mintIdentity)
    ) {
      reasons.push({
        code: 'LIFECYCLE_EVIDENCE_INVALID',
        message: 'Lifecycle participant identity aliases or contradicts existing provenance.',
        participant: participantId,
      });
      continue;
    }
    participantKeys.add(participantId);
    walletIdentities.set(participant.wallet.id, walletIdentity);
    mintIdentities.set(participant.mint.id, mintIdentity);
    acceptedEvidence.push(participant);
  }
  const wallets = new Set(acceptedEvidence.map(({ wallet }) => wallet.id));
  const mints = new Set(acceptedEvidence.map(({ mint }) => mint.implementation));
  const languages = new Set(acceptedEvidence.map(({ wallet }) => wallet.language));
  const builds = new Set(
    acceptedEvidence.map(({ wallet }) => `${wallet.sourceDigest}:${wallet.buildDigest}`),
  );
  if (wallets.size < suite.minimumWalletImplementations) {
    reasons.push({
      code: 'LIFECYCLE_MINIMUM_WALLETS',
      message: 'Two independent wallet implementations are required.',
    });
  }
  if (mints.size < suite.minimumMintImplementations) {
    reasons.push({
      code: 'LIFECYCLE_MINIMUM_MINTS',
      message: 'Two independent mint implementations are required.',
    });
  }
  if (languages.size < 2) {
    reasons.push({
      code: 'LIFECYCLE_CROSS_LANGUAGE',
      message: 'Cross-language wallet evidence is required.',
    });
  }
  if (builds.size < wallets.size) {
    reasons.push({
      code: 'LIFECYCLE_DISTINCT_BUILD',
      message: 'Each wallet must have distinct source and build provenance.',
    });
  }

  for (const participant of acceptedEvidence) {
    const participantId = `${participant.wallet.id}@${participant.mint.id}`;
    if (participant.releaseSuiteDigest !== suite.releaseSuiteDigest) {
      reasons.push({
        code: 'LIFECYCLE_POLICY_MISMATCH',
        message: 'Evidence was produced by another lifecycle suite.',
        participant: participantId,
      });
    }
    if (!participant.secretScanPassed) {
      reasons.push({
        code: 'LIFECYCLE_SECRET_SCAN',
        message: 'Lifecycle artifact secret scan did not pass.',
        participant: participantId,
      });
    }
    for (const operation of suite.requiredOperations) {
      if (!participant.operations.includes(operation)) {
        reasons.push({
          code: 'LIFECYCLE_OPERATION_MISSING',
          message: `Required operation ${operation} is missing.`,
          participant: participantId,
        });
      }
    }
    for (const scenarioId of suite.requiredScenarios) {
      const matches = participant.scenarios.filter(({ id }) => id === scenarioId);
      const scenario = matches[0];
      if (matches.length !== 1 || scenario?.status !== 'passed') {
        reasons.push({
          code: 'LIFECYCLE_REQUIRED_SCENARIO',
          message: `Required scenario ${scenarioId} did not uniquely pass.`,
          participant: participantId,
          scenario: scenarioId,
        });
      }
      if (
        scenario === undefined ||
        scenario.replayDigest === undefined ||
        !DIGEST.test(scenario.replayDigest)
      ) {
        reasons.push({
          code: 'LIFECYCLE_REPLAY_REQUIRED',
          message: `Required scenario ${scenarioId} has no exact replay digest.`,
          participant: participantId,
          scenario: scenarioId,
        });
      }
      for (const invariantId of suite.requiredInvariants) {
        const invariants = scenario?.invariants.filter(({ id }) => id === invariantId) ?? [];
        if (invariants.length !== 1 || invariants[0]?.status !== 'passed') {
          reasons.push({
            code: 'LIFECYCLE_REQUIRED_INVARIANT',
            message: `Required invariant ${invariantId} did not uniquely pass.`,
            participant: participantId,
            scenario: scenarioId,
          });
        }
      }
    }
  }

  reasons.sort((left, right) =>
    `${left.participant ?? ''}:${left.scenario ?? ''}:${left.code}`.localeCompare(
      `${right.participant ?? ''}:${right.scenario ?? ''}:${right.code}`,
    ),
  );
  return { passed: reasons.length === 0, reasons };
}
