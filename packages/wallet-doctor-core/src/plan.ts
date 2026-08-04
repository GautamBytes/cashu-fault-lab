import { mintProofKey } from './reconstruct.js';
import type { ProofView, TokenEventView } from './types.js';

/**
 * Dry-run repair plan model. A plan is a deterministic specification of relay
 * state changes; nothing is published by the doctor. Executors (a wallet or an
 * operator tool) need the proof secrets, which the doctor never stores.
 */
export type RepairStep =
  | {
      readonly action: 'republish_event';
      /** Existing token event that must reach relays that do not serve it. */
      readonly eventId: string;
      readonly toRelays: readonly string[];
    }
  | {
      readonly action: 'publish_rollover';
      /** Synthetic id of the planned consolidation event. */
      readonly rolloverId: string;
      readonly mint: string;
      readonly unit: string;
      /** `y` values the rollover must carry (mint-verified UNSPENT proofs). */
      readonly coveredYs: readonly string[];
      /** Token event ids the rollover destroys (`del`). */
      readonly del: readonly string[];
      readonly toRelays: readonly string[];
    }
  | {
      readonly action: 'delete_events';
      /** Token event ids a NIP-09 kind:5 with `["k", "7375"]` must target. */
      readonly eventIds: readonly string[];
      readonly toRelays: readonly string[];
    }
  | {
      readonly action: 'republish_wallet_event';
      readonly eventId: string;
      readonly toRelays: readonly string[];
    }
  | {
      readonly action: 'wallet_action';
      /** Orphaned proofs only a wallet holding the secrets can recover. */
      readonly kind: 'nut09_restore';
      readonly mint: string;
      readonly ys: readonly string[];
    };

export interface RepairPlan {
  readonly schemaVersion: 1;
  readonly subject: string;
  /** Domain-separated digest of the capture this plan was derived from. */
  readonly captureDigest: string;
  readonly steps: readonly RepairStep[];
}

/** Mutable relay-state view used by plan simulation. */
export interface PlanState {
  /** Currently live token events by id. */
  readonly liveTokens: Map<string, TokenEventView>;
  /** Every proof seen in the capture, indexed by `y` (amount resolution). */
  readonly proofsByY: ReadonlyMap<string, ProofView>;
}

export function initialPlanState(
  liveTokens: readonly TokenEventView[],
  allTokens: readonly TokenEventView[],
): PlanState {
  const proofsByY = new Map<string, ProofView>();
  for (const token of allTokens) {
    for (const proof of token.proofs) {
      const key = mintProofKey(token.mint, proof.y);
      if (!proofsByY.has(key)) proofsByY.set(key, proof);
    }
  }
  return {
    liveTokens: new Map(liveTokens.map((token) => [token.eventId, token])),
    proofsByY,
  };
}

function cloneState(state: PlanState): PlanState {
  return { liveTokens: new Map(state.liveTokens), proofsByY: state.proofsByY };
}

/**
 * Apply repair steps to relay state. Steps are set operations on the live
 * event set, so simulation is deterministic and applying a plan twice yields
 * the same state as applying it once (checked explicitly by the oracle).
 */
export function simulatePlan(state: PlanState, steps: readonly RepairStep[]): PlanState {
  const next = cloneState(state);
  for (const step of steps) {
    switch (step.action) {
      case 'publish_rollover': {
        const proofs: ProofView[] = [];
        for (const y of step.coveredYs) {
          const proof = next.proofsByY.get(mintProofKey(step.mint, y));
          if (!proof) {
            throw new Error(`rollover ${step.rolloverId} covers unknown proof y ${y}`);
          }
          proofs.push(proof);
        }
        for (const eventId of step.del) {
          next.liveTokens.delete(eventId);
        }
        next.liveTokens.set(step.rolloverId, {
          eventId: step.rolloverId,
          createdAt: Number.MAX_SAFE_INTEGER,
          mint: step.mint,
          unit: step.unit,
          proofs,
          del: step.del,
          seenOn: step.toRelays,
        });
        break;
      }
      case 'delete_events': {
        for (const eventId of step.eventIds) {
          next.liveTokens.delete(eventId);
        }
        break;
      }
      case 'republish_event':
      case 'republish_wallet_event':
      case 'wallet_action':
        break;
    }
  }
  return next;
}

export function planStateBalance(state: PlanState): number {
  let total = 0;
  for (const token of state.liveTokens.values()) {
    for (const proof of token.proofs) total += proof.amount;
  }
  return total;
}

/** Unique-proof balance: one proof counted once even across duplicate events. */
export function planStateUniqueBalance(state: PlanState): number {
  const seen = new Set<string>();
  let total = 0;
  for (const token of state.liveTokens.values()) {
    for (const proof of token.proofs) {
      const key = mintProofKey(token.mint, proof.y);
      if (seen.has(key)) continue;
      seen.add(key);
      total += proof.amount;
    }
  }
  return total;
}
