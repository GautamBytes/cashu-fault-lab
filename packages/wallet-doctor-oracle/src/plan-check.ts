import {
  dedupeEvents,
  initialPlanState,
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
    if (step.action === 'publish_rollover') for (const y of step.coveredYs) rolloverYs.add(y);
    if (step.action === 'wallet_action') for (const y of step.ys) restoreYs.add(y);
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
  const mintByY = new Map(observation.mint.map((entry) => [entry.y, entry]));
  const allTokens = dedupeEvents(
    observation.relays.filter((relay) => relay.status === 'ok').flatMap((relay) => relay.tokens),
  );
  const tokensById = new Map(allTokens.map((token) => [token.eventId, token]));
  const allWalletIds = new Set(
    observation.relays
      .filter((relay) => relay.status === 'ok')
      .flatMap((relay) => relay.wallet.map((event) => event.eventId)),
  );
  const knownYs = new Set(allTokens.flatMap((token) => token.proofs.map((proof) => proof.y)));
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
        if (!knownYs.has(y)) violations.push(`P3_UNKNOWN_REFERENCE: rollover covers ${y}`);
      }
      for (const eventId of step.del) {
        if (!tokensById.has(eventId)) {
          violations.push(`P3_UNKNOWN_REFERENCE: rollover del ${eventId}`);
        }
      }
    }
    if (step.action === 'wallet_action') {
      for (const y of step.ys) {
        if (!knownYs.has(y)) violations.push(`P3_UNKNOWN_REFERENCE: restore ${y}`);
      }
    }
  }

  // P1: no non-SPENT proof is deleted without rollover cover or restore.
  const { rolloverYs, restoreYs } = coveredSets(plan.steps);
  for (const step of plan.steps) {
    if (step.action !== 'delete_events') continue;
    for (const eventId of step.eventIds) {
      const token = tokensById.get(eventId);
      if (!token) continue;
      for (const proof of token.proofs) {
        const state = mintByY.get(proof.y)?.state;
        if (state === 'UNSPENT' || state === 'PENDING') {
          if (!rolloverYs.has(proof.y) && !restoreYs.has(proof.y)) {
            violations.push(`P1_UNCOVERED_UNSPENT: ${proof.y} deleted with ${eventId}`);
          }
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
  const liveProofs = merged.liveTokens.flatMap((token) => token.proofs);
  const unknownTruth = liveProofs.filter((proof) => !mintByY.has(proof.y));
  if (unknownTruth.length > 0) {
    violations.push(`MISSING_MINT_TRUTH: ${unknownTruth.length} live proof(s) unchecked`);
    return { ok: false, violations: violations.sort() };
  }

  // Convergence: no SPENT proof and no duplicate proof survives the plan.
  const finalYs = new Set<string>();
  let duplicates = 0;
  for (const token of once.liveTokens.values()) {
    for (const proof of token.proofs) {
      if (mintByY.get(proof.y)?.state === 'SPENT') {
        violations.push(`CONVERGENCE_SPENT_REMAINS: ${proof.y}`);
      }
      if (finalYs.has(proof.y)) duplicates += 1;
      finalYs.add(proof.y);
    }
  }
  if (duplicates > 0) violations.push('CONVERGENCE_DUPLICATE_REMAINS');

  const expected = new Set<string>();
  for (const proof of liveProofs) {
    const state = mintByY.get(proof.y)?.state;
    if (state === 'UNSPENT' || state === 'PENDING') expected.add(proof.y);
  }
  const expectedBalance = [...expected].reduce((total, y) => {
    const amount = [...merged.liveTokens, ...allTokens]
      .flatMap((token: TokenEventView) => token.proofs)
      .find((proof) => proof.y === y)?.amount;
    return total + (amount ?? 0);
  }, 0);
  if (planStateUniqueBalance(once) !== expectedBalance) {
    violations.push(
      `CONVERGENCE_BALANCE_MISMATCH: expected ${expectedBalance}, got ${planStateUniqueBalance(once)}`,
    );
  }

  return { ok: violations.length === 0, violations: violations.sort() };
}
