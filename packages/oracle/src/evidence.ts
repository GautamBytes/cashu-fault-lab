import { assertQuiescentLiveness, assertSafety } from './invariants.js';
import type {
  Observation,
  OracleCredit,
  OracleModel,
  OracleReceipt,
  OracleTransport,
} from './model.js';

export type InvariantId =
  | 'at-most-once-redemption-start'
  | 'at-most-one-merchant-credit-per-request'
  | 'at-most-one-merchant-credit-per-delivery'
  | 'proof-set-exclusivity'
  | 'delivery-identity-immutability'
  | 'exact-net-amount'
  | 'no-premature-settlement'
  | 'no-false-rejection-after-possible-consumption'
  | 'monotonic-receipts'
  | 'stable-duplicate-response'
  | 'eventual-terminal-or-recovery-state'
  | 'crash-recovery'
  | 'retry-convergence'
  | 'transport-convergence'
  | 'independent-mint-evidence'
  | 'independent-ledger-evidence'
  | 'reproducibility'
  | 'no-unsupported-pass';

export type InvariantStatus = 'passed' | 'failed' | 'not_applicable' | 'not_observable';
export type EvidenceConfidence = 'observed' | 'derived' | 'adapter_claimed';
export type InvariantEvidenceSource = 'timeline' | 'receipt' | 'ledger' | 'proofs' | 'capabilities';
export type EvidenceSourceConfidence = Readonly<
  Partial<
    Record<InvariantEvidenceSource, Extract<EvidenceConfidence, 'observed' | 'adapter_claimed'>>
  >
>;

export interface InvariantEvidenceReference {
  readonly source: InvariantEvidenceSource;
  readonly index?: number;
  readonly field?: string;
  readonly description: string;
}

export interface InvariantResult {
  readonly id: InvariantId;
  readonly status: InvariantStatus;
  readonly confidence: EvidenceConfidence;
  readonly evidence: readonly InvariantEvidenceReference[];
  readonly reason?: string;
}

export interface InvariantDefinition {
  readonly id: InvariantId;
  readonly category: 'safety' | 'liveness' | 'evidence';
  readonly description: string;
}

export const INVARIANT_REGISTRY: readonly InvariantDefinition[] = [
  {
    id: 'at-most-once-redemption-start',
    category: 'safety',
    description: 'One delivery binding starts mint redemption at most once.',
  },
  {
    id: 'at-most-one-merchant-credit-per-request',
    category: 'safety',
    description: 'A single-use request produces at most one merchant credit.',
  },
  {
    id: 'at-most-one-merchant-credit-per-delivery',
    category: 'safety',
    description: 'A delivery produces at most one merchant credit.',
  },
  {
    id: 'proof-set-exclusivity',
    category: 'safety',
    description: 'One proof set is bound to at most one delivery.',
  },
  {
    id: 'delivery-identity-immutability',
    category: 'safety',
    description: 'A delivery identifier retains one immutable identity.',
  },
  {
    id: 'exact-net-amount',
    category: 'safety',
    description: 'The settled receipt amount and unit match the durable credit.',
  },
  {
    id: 'no-premature-settlement',
    category: 'safety',
    description: 'Settlement requires recovered outputs and one matching credit.',
  },
  {
    id: 'no-false-rejection-after-possible-consumption',
    category: 'safety',
    description: 'Possibly consumed proofs are not reported as rejected.',
  },
  {
    id: 'monotonic-receipts',
    category: 'safety',
    description: 'Receipt versions are consistent and terminal states do not regress.',
  },
  {
    id: 'stable-duplicate-response',
    category: 'safety',
    description: 'Duplicate delivery attempts preserve identity and side effects.',
  },
  {
    id: 'eventual-terminal-or-recovery-state',
    category: 'liveness',
    description: 'Quiescence ends in a terminal or explicit recovery-blocked state.',
  },
  {
    id: 'crash-recovery',
    category: 'liveness',
    description: 'Restarted components resume without duplicated durable effects.',
  },
  {
    id: 'retry-convergence',
    category: 'liveness',
    description: 'Retries converge on the receiver receipt.',
  },
  {
    id: 'transport-convergence',
    category: 'liveness',
    description: 'HTTP and Nostr attempts converge on one delivery identity.',
  },
  {
    id: 'independent-mint-evidence',
    category: 'evidence',
    description: 'Mint proof state is independently observed.',
  },
  {
    id: 'independent-ledger-evidence',
    category: 'evidence',
    description: 'Merchant credit is independently observed from the ledger.',
  },
  {
    id: 'reproducibility',
    category: 'evidence',
    description: 'The run records deterministic inputs, versions, and ordered history.',
  },
  {
    id: 'no-unsupported-pass',
    category: 'evidence',
    description: 'Only declared role/profile combinations can execute as passes.',
  },
] as const;

export interface InvariantHistoryEntry {
  readonly sequence: number;
  readonly phase: string;
  readonly event: string;
  readonly data?: unknown;
}

export interface InvariantCommand {
  readonly type: string;
  readonly target?: string;
  readonly component?: string;
  readonly boundary?: string;
  readonly rule?: { readonly kind?: string };
}

export interface InvariantRunMetadata {
  readonly scenarioId?: string;
  readonly seed?: string;
  readonly componentVersions?: Readonly<Record<string, string>>;
}

export interface EvaluateInvariantsInput {
  readonly model: OracleModel;
  readonly history: readonly InvariantHistoryEntry[];
  readonly commands: readonly InvariantCommand[];
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly metadata?: InvariantRunMetadata;
  readonly profile?: string;
  readonly observationConfidence?: Extract<EvidenceConfidence, 'observed' | 'adapter_claimed'>;
  readonly sourceConfidence?: EvidenceSourceConfidence;
}

function evidence(
  source: InvariantEvidenceSource,
  description: string,
  index?: number,
  field?: string,
): InvariantEvidenceReference {
  return {
    source,
    ...(index === undefined ? {} : { index }),
    ...(field === undefined ? {} : { field }),
    description,
  };
}

function passed(
  id: InvariantId,
  confidence: EvidenceConfidence,
  references: readonly InvariantEvidenceReference[],
): InvariantResult {
  return { id, status: 'passed', confidence, evidence: references };
}

function failed(
  id: InvariantId,
  reason: string,
  references: readonly InvariantEvidenceReference[],
): InvariantResult {
  return { id, status: 'failed', confidence: 'observed', evidence: references, reason };
}

function notApplicable(id: InvariantId, reason: string): InvariantResult {
  return { id, status: 'not_applicable', confidence: 'derived', evidence: [], reason };
}

function notObservable(
  id: InvariantId,
  reason: string,
  references: readonly InvariantEvidenceReference[] = [],
): InvariantResult {
  return { id, status: 'not_observable', confidence: 'derived', evidence: references, reason };
}

function observations<T extends Observation['type']>(
  model: OracleModel,
  type: T,
): readonly Extract<Observation, { readonly type: T }>[] {
  return model.observations.filter(
    (item): item is Extract<Observation, { readonly type: T }> => item.type === type,
  );
}

function countBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

function groupedBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const selected = key(item);
    groups.set(selected, [...(groups.get(selected) ?? []), item]);
  }
  return groups;
}

function firstObservationIndex(model: OracleModel, type: Observation['type']): number | undefined {
  const index = model.observations.findIndex((item) => item.type === type);
  return index < 0 ? undefined : index;
}

function safetyFailure(model: OracleModel): string | undefined {
  try {
    assertSafety(model);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Oracle safety violation';
  }
}

function matchingSafetyFailure(message: string | undefined, pattern: RegExp): string | undefined {
  return message !== undefined && pattern.test(message) ? message : undefined;
}

function latestReceipts(receipts: readonly OracleReceipt[]): readonly OracleReceipt[] {
  return [...groupedBy(receipts, (item) => item.deliveryId).values()].map(
    (items) => [...items].sort((left, right) => right.version - left.version)[0]!,
  );
}

function roleProfiles(
  capabilities: Readonly<Record<string, unknown>> | undefined,
  role: 'sender' | 'receiver',
): readonly string[] | undefined {
  if (capabilities === undefined) return undefined;
  const directRoles =
    typeof capabilities.roles === 'object' &&
    capabilities.roles !== null &&
    !Array.isArray(capabilities.roles)
      ? (capabilities.roles as Readonly<Record<string, unknown>>)
      : undefined;
  const externalRole =
    typeof capabilities[role] === 'object' &&
    capabilities[role] !== null &&
    !Array.isArray(capabilities[role])
      ? (capabilities[role] as Readonly<Record<string, unknown>>)
      : undefined;
  const selected =
    (directRoles?.[role] as Readonly<Record<string, unknown>> | undefined) ??
    (externalRole?.role as Readonly<Record<string, unknown>> | undefined);
  return Array.isArray(selected?.profiles)
    ? selected.profiles.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function duplicateAttemptsByDelivery(
  attempts: readonly Extract<Observation, { readonly type: 'delivery_attempted' }>[],
): ReadonlyMap<string, number> {
  return countBy(attempts, (item) => item.deliveryId);
}

function transportSets(
  attempts: readonly Extract<Observation, { readonly type: 'delivery_attempted' }>[],
): ReadonlyMap<string, ReadonlySet<OracleTransport>> {
  const result = new Map<string, Set<OracleTransport>>();
  for (const attempt of attempts) {
    const values = result.get(attempt.deliveryId) ?? new Set<OracleTransport>();
    values.add(attempt.transport);
    result.set(attempt.deliveryId, values);
  }
  return result;
}

function ledgerReference(model: OracleModel): InvariantEvidenceReference {
  return evidence(
    'ledger',
    'Receiver ledger observation records merchant credit cardinality and value.',
    firstObservationIndex(model, 'merchant_credited'),
  );
}

function receiptReference(model: OracleModel): InvariantEvidenceReference {
  return evidence(
    'receipt',
    'Receiver receipt observation records delivery status and version.',
    firstObservationIndex(model, 'receipt_observed'),
  );
}

function proofReference(model: OracleModel): InvariantEvidenceReference {
  return evidence(
    'proofs',
    'Mint evidence binds the delivery to its input proof-set identity and state.',
    firstObservationIndex(model, 'mint_proofs_state'),
  );
}

function evaluateSafetyAndLiveness(input: EvaluateInvariantsInput): readonly InvariantResult[] {
  const { model, commands } = input;
  const observationConfidence = input.observationConfidence ?? 'observed';
  const attempts = observations(model, 'delivery_attempted');
  const requests = observations(model, 'request_observed');
  const redemptions = observations(model, 'redemption_started');
  const settlements = observations(model, 'receiver_settled');
  const credits = observations(model, 'merchant_credited');
  const receipts = observations(model, 'receipt_observed');
  const proofStates = observations(model, 'mint_proofs_state');
  const latest = latestReceipts(receipts);
  const safety = safetyFailure(model);
  const results: InvariantResult[] = [];

  const redemptionId: InvariantId = 'at-most-once-redemption-start';
  const rejectedDeliveries = new Set(
    latest.filter((receipt) => receipt.status === 'rejected').map((receipt) => receipt.deliveryId),
  );
  const unspentProofSets = new Set(
    proofStates
      .filter((proofState) => proofState.state === 'UNSPENT')
      .map((proofState) => proofState.proofSetHash),
  );
  const observedPreRedemptionRejection =
    attempts.length > 0 &&
    attempts.every(
      (attempt) =>
        rejectedDeliveries.has(attempt.deliveryId) && unspentProofSets.has(attempt.proofSetHash),
    );
  if (attempts.length === 0) {
    results.push(notApplicable(redemptionId, 'No delivery was attempted.'));
  } else if (redemptions.length === 0 && observedPreRedemptionRejection) {
    results.push(
      notApplicable(redemptionId, 'The observed delivery was rejected before mint redemption.'),
    );
  } else if (redemptions.length === 0) {
    results.push(notObservable(redemptionId, 'Mint redemption-start evidence is unavailable.'));
  } else {
    const violation = [...countBy(redemptions, (item) => item.deliveryId).values()].some(
      (count) => count > 1,
    );
    results.push(
      violation
        ? failed(redemptionId, 'A delivery started mint redemption more than once.', [
            evidence('proofs', 'Mint redemption evidence contains a duplicate delivery start.'),
          ])
        : passed(redemptionId, observationConfidence, [
            evidence(
              'proofs',
              'Mint redemption evidence contains one start per delivery.',
              firstObservationIndex(model, 'redemption_started'),
            ),
          ]),
    );
  }

  const requestCreditId: InvariantId = 'at-most-one-merchant-credit-per-request';
  const singleUse = new Set(
    requests.filter((item) => item.singleUse).map((item) => item.requestId),
  );
  if (singleUse.size === 0) {
    results.push(notApplicable(requestCreditId, 'No single-use request was observed.'));
  } else if (credits.length === 0 && observedPreRedemptionRejection) {
    results.push(
      notApplicable(requestCreditId, 'The observed request was rejected before settlement.'),
    );
  } else if (credits.length === 0) {
    results.push(
      notObservable(requestCreditId, 'Durable merchant ledger evidence is unavailable.'),
    );
  } else {
    const violation = [...countBy(credits, (item) => item.requestId)].some(
      ([requestId, count]) => singleUse.has(requestId) && count > 1,
    );
    results.push(
      violation
        ? failed(requestCreditId, 'A single-use request produced more than one credit.', [
            ledgerReference(model),
          ])
        : passed(requestCreditId, observationConfidence, [ledgerReference(model)]),
    );
  }

  const deliveryCreditId: InvariantId = 'at-most-one-merchant-credit-per-delivery';
  if (attempts.length === 0) {
    results.push(notApplicable(deliveryCreditId, 'No delivery was attempted.'));
  } else if (credits.length === 0 && observedPreRedemptionRejection) {
    results.push(
      notApplicable(deliveryCreditId, 'The observed delivery was rejected before settlement.'),
    );
  } else if (credits.length === 0) {
    results.push(
      notObservable(deliveryCreditId, 'Durable merchant ledger evidence is unavailable.'),
    );
  } else {
    const violation = [...countBy(credits, (item) => item.deliveryId).values()].some(
      (count) => count > 1,
    );
    results.push(
      violation
        ? failed(deliveryCreditId, 'A delivery produced more than one merchant credit.', [
            ledgerReference(model),
          ])
        : passed(deliveryCreditId, observationConfidence, [ledgerReference(model)]),
    );
  }

  const proofId: InvariantId = 'proof-set-exclusivity';
  if (attempts.length === 0) {
    results.push(notApplicable(proofId, 'No proof set was bound to a delivery.'));
  } else {
    const owners = new Map<string, Set<string>>();
    for (const attempt of attempts) {
      const values = owners.get(attempt.proofSetHash) ?? new Set<string>();
      values.add(attempt.deliveryId);
      owners.set(attempt.proofSetHash, values);
    }
    const violation = [...owners.values()].some((values) => values.size > 1);
    results.push(
      violation
        ? failed(proofId, 'A proof set was bound to more than one delivery.', [
            evidence('timeline', 'Delivery-attempt observations expose conflicting proof owners.'),
            proofReference(model),
          ])
        : passed(proofId, 'derived', [
            evidence(
              'timeline',
              'Delivery-attempt identities derive a unique owner for every proof set.',
              firstObservationIndex(model, 'delivery_attempted'),
            ),
            proofReference(model),
          ]),
    );
  }

  const identityId: InvariantId = 'delivery-identity-immutability';
  if (attempts.length === 0) {
    results.push(notApplicable(identityId, 'No delivery identity was observed.'));
  } else {
    const violation = matchingSafetyFailure(safety, /delivery .* identity is immutable/u);
    results.push(
      violation === undefined
        ? passed(identityId, 'derived', [
            evidence(
              'timeline',
              'Ordered delivery-attempt observations retain one identity per delivery.',
              firstObservationIndex(model, 'delivery_attempted'),
            ),
            receiptReference(model),
            proofReference(model),
          ])
        : failed(identityId, violation, [
            evidence('timeline', 'Delivery-attempt observations contain an identity conflict.'),
            receiptReference(model),
            proofReference(model),
          ]),
    );
  }

  const amountId: InvariantId = 'exact-net-amount';
  const settledReceipts = latest.filter((item) => item.status === 'settled');
  if (settledReceipts.length === 0) {
    results.push(notApplicable(amountId, 'No settled receipt was observed.'));
  } else if (credits.length === 0) {
    results.push(notObservable(amountId, 'A matching durable credit was not observable.'));
  } else {
    const byDelivery = groupedBy<OracleCredit>(credits, (item) => item.deliveryId);
    const violation = settledReceipts.some((receipt) => {
      const matching = byDelivery.get(receipt.deliveryId);
      return (
        matching?.length !== 1 ||
        matching[0]?.amount !== receipt.amount ||
        matching[0]?.unit !== receipt.unit
      );
    });
    results.push(
      violation
        ? failed(amountId, 'A settled receipt does not match its merchant credit value.', [
            receiptReference(model),
            ledgerReference(model),
          ])
        : passed(amountId, observationConfidence, [
            receiptReference(model),
            ledgerReference(model),
          ]),
    );
  }

  const prematureId: InvariantId = 'no-premature-settlement';
  if (settledReceipts.length === 0) {
    results.push(notApplicable(prematureId, 'No settled receipt was observed.'));
  } else {
    const settlementIds = new Set(settlements.map((item) => item.deliveryId));
    const creditCounts = countBy(credits, (item) => item.deliveryId);
    const violation = settledReceipts.some(
      (item) => !settlementIds.has(item.deliveryId) || creditCounts.get(item.deliveryId) !== 1,
    );
    results.push(
      violation
        ? failed(prematureId, 'Settlement lacks recovered-output or durable-credit evidence.', [
            receiptReference(model),
            ledgerReference(model),
            proofReference(model),
          ])
        : passed(prematureId, observationConfidence, [
            receiptReference(model),
            ledgerReference(model),
            proofReference(model),
            evidence(
              'timeline',
              'Receiver settlement observation binds recovered replacement outputs.',
              firstObservationIndex(model, 'receiver_settled'),
            ),
          ]),
    );
  }

  const rejectionId: InvariantId = 'no-false-rejection-after-possible-consumption';
  const rejected = latest.filter((item) => item.status === 'rejected');
  const ambiguousReceiverCrash = commands.some(
    (command) =>
      command.type === 'arm_crash' &&
      command.component === 'receiver' &&
      (command.boundary === 'receiver_after_mint_request_before_response' ||
        command.boundary === 'receiver_after_mint_response_before_output_persistence'),
  );
  const attemptedDeliveryIds = new Set(attempts.map((attempt) => attempt.deliveryId));
  const rejectedAfterBinding = rejected.filter((receipt) =>
    attemptedDeliveryIds.has(receipt.deliveryId),
  );
  const relevantDeliveryIds = new Set(
    (rejectedAfterBinding.length > 0 ? rejectedAfterBinding : latest).map(
      (receipt) => receipt.deliveryId,
    ),
  );
  const relevantProofSets = new Set(
    attempts
      .filter((attempt) => relevantDeliveryIds.has(attempt.deliveryId))
      .map((attempt) => attempt.proofSetHash),
  );
  const relevantProofStates = proofStates.filter((proofState) =>
    relevantProofSets.has(proofState.proofSetHash),
  );
  const rejectionViolation = matchingSafetyFailure(safety, /rejected proofs after they may/u);
  if (rejected.length === 0 && !ambiguousReceiverCrash) {
    results.push(notApplicable(rejectionId, 'No rejected receipt was observed.'));
  } else if (
    rejected.length > 0 &&
    rejectedAfterBinding.length === 0 &&
    !ambiguousReceiverCrash
  ) {
    results.push(
      notApplicable(rejectionId, 'The delivery was rejected before delivery binding.'),
    );
  } else if (ambiguousReceiverCrash && rejected.length > 0) {
    results.push(
      failed(
        rejectionId,
        rejectionViolation ?? 'Receiver rejected a delivery after an ambiguous mint request.',
        rejectionViolation === undefined
          ? [receiptReference(model)]
          : [receiptReference(model), proofReference(model)],
      ),
    );
  } else if (receipts.length === 0) {
    results.push(
      notObservable(rejectionId, 'Receiver receipt evidence is unavailable after mint dispatch.'),
    );
  } else if (relevantProofStates.length === 0) {
    results.push(
      notObservable(rejectionId, 'Mint proof evidence is unavailable for the rejected delivery.'),
    );
  } else {
    results.push(
      rejectionViolation === undefined
        ? passed(rejectionId, observationConfidence, [
            receiptReference(model),
            evidence(
              'proofs',
              'Mint proof-state observation distinguishes safe rejection from possible consumption.',
              firstObservationIndex(model, 'mint_proofs_state'),
            ),
          ])
        : failed(rejectionId, rejectionViolation, [receiptReference(model)]),
    );
  }

  const receiptId: InvariantId = 'monotonic-receipts';
  if (receipts.length === 0) {
    results.push(notApplicable(receiptId, 'No receipt was observed.'));
  } else {
    const violation = matchingSafetyFailure(
      safety,
      /receipt .* invalid version|receipt .* conflicting|terminal receipt .* regressed/u,
    );
    results.push(
      violation === undefined
        ? passed(receiptId, 'derived', [receiptReference(model)])
        : failed(receiptId, violation, [receiptReference(model)]),
    );
  }

  const duplicateId: InvariantId = 'stable-duplicate-response';
  const duplicates = [...duplicateAttemptsByDelivery(attempts).values()].some((count) => count > 1);
  if (!duplicates) {
    results.push(notApplicable(duplicateId, 'No duplicate delivery attempt was observed.'));
  } else if (receipts.length === 0) {
    results.push(notObservable(duplicateId, 'A stored receipt was not observable after retry.'));
  } else {
    const violation = matchingSafetyFailure(
      safety,
      /identity is immutable|one credit|redemption .* at most once|receipt .* conflicting/u,
    );
    results.push(
      violation === undefined
        ? passed(duplicateId, 'derived', [
            evidence(
              'timeline',
              'Repeated delivery attempts retain one identity and side-effect set.',
              firstObservationIndex(model, 'delivery_attempted'),
            ),
            receiptReference(model),
            ledgerReference(model),
            proofReference(model),
          ])
        : failed(duplicateId, violation, [
            receiptReference(model),
            ledgerReference(model),
            proofReference(model),
          ]),
    );
  }

  const terminalId: InvariantId = 'eventual-terminal-or-recovery-state';
  if (!commands.some((command) => command.type === 'assert_quiescent')) {
    results.push(notApplicable(terminalId, 'The scenario does not assert quiescence.'));
  } else if (attempts.length === 0) {
    results.push(notApplicable(terminalId, 'No delivery was attempted.'));
  } else {
    try {
      assertQuiescentLiveness(model);
      results.push(passed(terminalId, 'derived', [receiptReference(model)]));
    } catch (error) {
      results.push(
        failed(
          terminalId,
          error instanceof Error ? error.message : 'The delivery did not become quiescent.',
          [receiptReference(model)],
        ),
      );
    }
  }

  const crashId: InvariantId = 'crash-recovery';
  if (!commands.some((command) => command.type === 'restart' || command.type === 'arm_crash')) {
    results.push(notApplicable(crashId, 'The scenario does not restart a component.'));
  } else if (receipts.length === 0 || credits.length === 0) {
    results.push(
      notObservable(crashId, 'Post-restart receipt and durable ledger evidence are required.'),
    );
  } else if (safety !== undefined) {
    results.push(failed(crashId, safety, [receiptReference(model), ledgerReference(model)]));
  } else {
    results.push(
      passed(crashId, 'derived', [
        evidence(
          'timeline',
          'Scenario command history contains an observed or armed component restart.',
        ),
        receiptReference(model),
        ledgerReference(model),
      ]),
    );
  }

  const retryId: InvariantId = 'retry-convergence';
  const retryFaultKinds = new Set(['drop_request', 'drop_response', 'duplicate']);
  const retryApplies =
    duplicates ||
    commands.some(
      (command) =>
        command.type === 'configure_fault' &&
        (command.target === 'http' || command.target === 'nostr') &&
        command.rule?.kind !== undefined &&
        retryFaultKinds.has(command.rule.kind),
    );
  if (!retryApplies) {
    results.push(notApplicable(retryId, 'The scenario does not exercise delivery retries.'));
  } else if (receipts.length === 0) {
    results.push(notObservable(retryId, 'No converged receiver receipt was observable.'));
  } else {
    results.push(
      safety === undefined
        ? passed(retryId, 'derived', [receiptReference(model)])
        : failed(retryId, safety, [receiptReference(model)]),
    );
  }

  const transportId: InvariantId = 'transport-convergence';
  const multipleTransports = [...transportSets(attempts).values()].some(
    (values) => values.size > 1,
  );
  if (!multipleTransports) {
    results.push(notApplicable(transportId, 'The scenario does not use multiple transports.'));
  } else if (receipts.length === 0) {
    results.push(notObservable(transportId, 'No receipt was observable across transports.'));
  } else {
    results.push(
      safety === undefined
        ? passed(transportId, 'derived', [
            evidence(
              'timeline',
              'HTTP and Nostr attempts share one immutable delivery identity.',
              firstObservationIndex(model, 'delivery_attempted'),
            ),
            receiptReference(model),
            proofReference(model),
          ])
        : failed(transportId, safety, [receiptReference(model), proofReference(model)]),
    );
  }

  return results;
}

function evaluateEvidence(input: EvaluateInvariantsInput): readonly InvariantResult[] {
  const { model, metadata, capabilities } = input;
  const observationConfidence = input.observationConfidence ?? 'observed';
  const attempts = observations(model, 'delivery_attempted');
  const proofStates = observations(model, 'mint_proofs_state');
  const credits = observations(model, 'merchant_credited');
  const settledReceipts = latestReceipts(observations(model, 'receipt_observed')).filter(
    (receipt) => receipt.status === 'settled',
  );
  const results: InvariantResult[] = [];

  const mintId: InvariantId = 'independent-mint-evidence';
  if (attempts.length === 0) {
    results.push(notApplicable(mintId, 'No delivery requiring mint evidence was attempted.'));
  } else if (proofStates.length === 0) {
    results.push(notObservable(mintId, 'Independent mint proof evidence is unavailable.'));
  } else {
    results.push(
      passed(mintId, observationConfidence, [
        evidence(
          'proofs',
          'Mint proof-state endpoint observation records the input state.',
          firstObservationIndex(model, 'mint_proofs_state'),
        ),
      ]),
    );
  }

  const ledgerId: InvariantId = 'independent-ledger-evidence';
  if (settledReceipts.length === 0) {
    results.push(notApplicable(ledgerId, 'No settled delivery requires ledger evidence.'));
  } else if (credits.length === 0) {
    results.push(notObservable(ledgerId, 'Independent durable ledger evidence is unavailable.'));
  } else {
    results.push(passed(ledgerId, observationConfidence, [ledgerReference(model)]));
  }

  const reproducibilityId: InvariantId = 'reproducibility';
  const reproducible =
    typeof metadata?.scenarioId === 'string' &&
    metadata.scenarioId.length > 0 &&
    typeof metadata.seed === 'string' &&
    metadata.seed.length > 0 &&
    Object.keys(metadata.componentVersions ?? {}).length > 0 &&
    input.history.length > 0 &&
    input.history.every((entry, index) => entry.sequence === index);
  results.push(
    reproducible
      ? passed(reproducibilityId, 'derived', [
          evidence('timeline', 'Scenario ID, seed, versions, and ordered history are recorded.'),
        ])
      : notObservable(
          reproducibilityId,
          'Scenario ID, seed, component versions, and ordered history are required.',
        ),
  );

  const unsupportedId: InvariantId = 'no-unsupported-pass';
  const profile = input.profile ?? 'delivery-v1';
  const senderProfiles = roleProfiles(capabilities, 'sender');
  const receiverProfiles = roleProfiles(capabilities, 'receiver');
  if (senderProfiles === undefined || receiverProfiles === undefined) {
    results.push(
      notObservable(
        unsupportedId,
        'Role-specific sender and receiver capabilities are unavailable.',
      ),
    );
  } else if (!senderProfiles.includes(profile) || !receiverProfiles.includes(profile)) {
    results.push(
      failed(unsupportedId, `Executed profile ${profile} was not declared by both roles.`, [
        evidence(
          'capabilities',
          'Role-specific capability declarations omit the executed profile.',
        ),
      ]),
    );
  } else {
    results.push(
      passed(unsupportedId, 'derived', [
        evidence(
          'capabilities',
          'Both executed roles declare the selected profile and the runner observed execution.',
        ),
      ]),
    );
  }
  return results;
}

export function evaluateInvariants(input: EvaluateInvariantsInput): readonly InvariantResult[] {
  const byId = new Map(
    [...evaluateSafetyAndLiveness(input), ...evaluateEvidence(input)].map((result) => [
      result.id,
      result,
    ]),
  );
  return INVARIANT_REGISTRY.map((definition) => {
    const result = byId.get(definition.id);
    if (result === undefined) {
      throw new Error(`Invariant evaluator omitted ${definition.id}`);
    }
    const adapterClaimed =
      (input.observationConfidence === 'adapter_claimed' && result.confidence === 'observed') ||
      result.evidence.some(
        (reference) => input.sourceConfidence?.[reference.source] === 'adapter_claimed',
      );
    return adapterClaimed ? { ...result, confidence: 'adapter_claimed' } : result;
  });
}

export function unobservableInvariantResults(reason: string): readonly InvariantResult[] {
  if (reason.length === 0) throw new Error('Invariant unobservable reason is required');
  return INVARIANT_REGISTRY.map(({ id }) => notObservable(id, reason));
}
