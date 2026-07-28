import { isDevelopmentIdentity, type EvidenceTier } from '@cashu-fault-lab/adapter-contract';
import {
  INVARIANT_REGISTRY,
  type EvidenceConfidence,
  type InvariantId,
} from '@cashu-fault-lab/oracle';
import type { MatrixCaseResult } from './matrix.js';

export interface ReleasePolicy {
  readonly schemaVersion: 2;
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
  | 'MINIMUM_DISTINCT_MINTS';

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
  if (input.schemaVersion !== 2) throw new Error('Release policy schemaVersion must be 2');
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
    schemaVersion: 2,
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
