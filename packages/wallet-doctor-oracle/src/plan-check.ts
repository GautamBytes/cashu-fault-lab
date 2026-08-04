import {
  dedupeEvents,
  indexMintTruth,
  initialPlanState,
  mintProofKey,
  planStateUniqueBalance,
  reconstruct,
  simulatePlan,
  type DoctorObservation,
  type RepairPlan,
  type RepairStep,
  type TokenEventView,
} from '@cashu-fault-lab/wallet-doctor-core';

export interface PlanCheckResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

function coveredSets(steps: readonly RepairStep[]): {
  rolloverYs: Set<string>;
  restoreYs: Set<string>;
} {
  const rolloverYs = new Set<string>();
  const restoreYs = new Set<string>();
  for (const step of steps) {
    if (step.action === 'publish_rollover') {
      for (const y of step.coveredYs) rolloverYs.add(mintProofKey(step.mint, y));
    }
    if (step.action === 'wallet_action') {
      for (const y of step.ys) restoreYs.add(mintProofKey(step.mint, y));
    }
  }
  return { rolloverYs, restoreYs };
}

/**
 * Verify the three plan-safety invariants plus post-plan convergence against
 * mint truth:
 *
 * - P1: no deletion drops a non-SPENT proof that no rollover covers and no
 *   wallet action restores.
 * - P2: applying the plan twice yields the state of applying it once.
 * - P3: every event id and proof the plan references exists in the capture.
 * - Convergence: after simulation, no SPENT proof stays live, no proof is
 *   duplicated across live events, and the unique-proof balance equals the
 *   non-SPENT value the live events carried before the plan.
 */
export function checkRepairPlan(input: {
  readonly observation: DoctorObservation;
  readonly plan: RepairPlan;
}): PlanCheckResult {
  const { observation, plan } = input;
  const { merged } = reconstruct(observation);
  const mintByY = indexMintTruth(observation.mint);
  const allTokens = dedupeEvents(
    observation.relays.filter((relay) => relay.status === 'ok').flatMap((relay) => relay.tokens),
  );
  const tokensById = new Map(allTokens.map((token) => [token.eventId, token]));
  const allWalletIds = new Set(
    observation.relays
      .filter((relay) => relay.status === 'ok')
      .flatMap((relay) => relay.wallet.map((event) => event.eventId)),
  );
  const knownYs = new Set(
    allTokens.flatMap((token) => token.proofs.map((proof) => mintProofKey(token.mint, proof.y))),
  );
  const violations: string[] = [];

  // P3: references exist.
  for (const step of plan.steps) {
    if (step.action === 'republish_event' && !tokensById.has(step.eventId)) {
      violations.push(`P3_UNKNOWN_REFERENCE: republish ${step.eventId}`);
    }
    if (step.action === 'republish_wallet_event' && !allWalletIds.has(step.eventId)) {
      violations.push(`P3_UNKNOWN_REFERENCE: wallet event ${step.eventId}`);
    }
    if (step.action === 'delete_events') {
      for (const eventId of step.eventIds) {
        if (!tokensById.has(eventId)) {
          violations.push(`P3_UNKNOWN_REFERENCE: delete ${eventId}`);
        }
      }
    }
    if (step.action === 'publish_rollover') {
      for (const y of step.coveredYs) {
        if (!knownYs.has(mintProofKey(step.mint, y))) {
          violations.push(`P3_UNKNOWN_REFERENCE: rollover covers ${y}`);
        }
      }
      for (const eventId of step.del) {
        if (!tokensById.has(eventId)) {
          violations.push(`P3_UNKNOWN_REFERENCE: rollover del ${eventId}`);
        }
      }
    }
    if (step.action === 'wallet_action') {
      for (const y of step.ys) {
        if (!knownYs.has(mintProofKey(step.mint, y))) {
          violations.push(`P3_UNKNOWN_REFERENCE: restore ${y}`);
        }
      }
    }
  }

  // P1: no non-SPENT proof is deleted without rollover cover or restore.
  // Deletions happen through delete_events steps AND publish_rollover `del`
  // lists (simulation treats both as removals from the live set). A proof
  // whose mint state is unknown cannot be proven safe to delete, so unknown
  // truth on a deleted event is itself a violation.
  const { rolloverYs, restoreYs } = coveredSets(plan.steps);
  const deletedEventIds: string[] = [];
  for (const step of plan.steps) {
    if (step.action === 'delete_events') deletedEventIds.push(...step.eventIds);
    if (step.action === 'publish_rollover') deletedEventIds.push(...step.del);
  }
  for (const eventId of deletedEventIds) {
    const token = tokensById.get(eventId);
    if (!token) continue;
    for (const proof of token.proofs) {
      const key = mintProofKey(token.mint, proof.y);
      const state = mintByY.get(key)?.state;
      if (state === undefined) {
        violations.push(`MISSING_MINT_TRUTH: ${proof.y} deleted with ${eventId} is unchecked`);
        continue;
      }
      if (state === 'UNSPENT' || state === 'PENDING') {
        if (!rolloverYs.has(key) && !restoreYs.has(key)) {
          violations.push(`P1_UNCOVERED_UNSPENT: ${proof.y} deleted with ${eventId}`);
        }
      }
    }
  }

  // Simulation-based invariants need resolvable proofs.
  let once;
  let twice;
  try {
    const initial = initialPlanState(merged.liveTokens, allTokens);
    once = simulatePlan(initial, plan.steps);
    twice = simulatePlan(once, plan.steps);
  } catch (error) {
    violations.push(`P3_UNKNOWN_REFERENCE: ${(error as Error).message}`);
    return { ok: false, violations: violations.sort() };
  }

  // P2: idempotence.
  const onceKeys = [...once.liveTokens.keys()].sort();
  const twiceKeys = [...twice.liveTokens.keys()].sort();
  if (
    onceKeys.join(',') !== twiceKeys.join(',') ||
    planStateUniqueBalance(once) !== planStateUniqueBalance(twice)
  ) {
    violations.push('P2_NOT_IDEMPOTENT');
  }

  // Convergence requires complete mint truth over pre-plan live proofs.
  const liveProofs = merged.liveTokens.flatMap((token) =>
    token.proofs.map((proof) => ({ mint: token.mint, proof })),
  );
  const unknownTruth = liveProofs.filter(
    ({ mint, proof }) => !mintByY.has(mintProofKey(mint, proof.y)),
  );
  if (unknownTruth.length > 0) {
    violations.push(`MISSING_MINT_TRUTH: ${unknownTruth.length} live proof(s) unchecked`);
    return { ok: false, violations: violations.sort() };
  }

  // Convergence: no SPENT proof and no duplicate proof survives the plan.
  const finalYs = new Set<string>();
  let duplicates = 0;
  for (const token of once.liveTokens.values()) {
    for (const proof of token.proofs) {
      const key = mintProofKey(token.mint, proof.y);
      if (mintByY.get(key)?.state === 'SPENT') {
        violations.push(`CONVERGENCE_SPENT_REMAINS: ${proof.y}`);
      }
      if (finalYs.has(key)) duplicates += 1;
      finalYs.add(key);
    }
  }
  if (duplicates > 0) violations.push('CONVERGENCE_DUPLICATE_REMAINS');

  const expected = new Set<string>();
  for (const { mint, proof } of liveProofs) {
    const key = mintProofKey(mint, proof.y);
    const state = mintByY.get(key)?.state;
    if (state === 'UNSPENT' || state === 'PENDING') expected.add(key);
  }
  const expectedBalance = [...expected].reduce((total, key) => {
    const amount = [...merged.liveTokens, ...allTokens]
      .flatMap((token: TokenEventView) =>
        token.proofs.map((proof) => ({ key: mintProofKey(token.mint, proof.y), proof })),
      )
      .find((entry) => entry.key === key)?.proof.amount;
    return total + (amount ?? 0);
  }, 0);
  if (planStateUniqueBalance(once) !== expectedBalance) {
    violations.push(
      `CONVERGENCE_BALANCE_MISMATCH: expected ${expectedBalance}, got ${planStateUniqueBalance(once)}`,
    );
  }

  return { ok: violations.length === 0, violations: violations.sort() };
}
