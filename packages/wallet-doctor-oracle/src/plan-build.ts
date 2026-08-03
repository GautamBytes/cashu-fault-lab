import {
  reconstruct,
  type DoctorObservation,
  type MintObservation,
  type RepairPlan,
  type RepairStep,
  type TokenEventView,
} from '@cashu-fault-lab/wallet-doctor-core';
import type { Diagnosis, Finding } from './diagnose.js';

export interface BuildPlanInput {
  readonly observation: DoctorObservation;
  readonly diagnosis: Diagnosis;
  /** Domain-separated digest of the capture bundle this plan derives from. */
  readonly captureDigest: string;
}

/** Proof states a repair rollover must keep. SPENT proofs are dropped only. */
const COVERED_STATES: ReadonlySet<MintObservation['state']> = new Set(['UNSPENT', 'PENDING']);

function eventYs(token: TokenEventView): readonly string[] {
  return token.proofs.map((proof) => proof.y);
}

/**
 * Derive a deterministic dry-run repair plan from a diagnosis.
 *
 * Strategy: mints with ghost or broken-chain findings are consolidated into
 * one planned rollover per mint covering exactly the non-SPENT proofs of that
 * mint's live events, followed by NIP-09 deletions of everything it replaces.
 * Healthy partitioned events get a minimal republish. Orphaned unspent proofs
 * become wallet-action instructions (NUT-09 restore) because only a wallet
 * holding the secrets can recover them.
 */
export function buildRepairPlan(input: BuildPlanInput): RepairPlan {
  const { observation, diagnosis } = input;
  const { merged } = reconstruct(observation);
  const mintByY = new Map(observation.mint.map((entry) => [entry.y, entry]));
  const okRelays = observation.relays
    .filter((relay) => relay.status === 'ok')
    .map((relay) => relay.url)
    .sort();

  const consolidationMints = new Set<string>();
  const brokenEventIds = new Set<string>();
  for (const finding of diagnosis.findings) {
    if (finding.code === 'GHOST_TOKEN' || finding.code === 'DEL_CHAIN_BREAK') {
      for (const eventId of finding.eventIds) {
        const token = findToken(merged.liveTokens, merged.naiveLiveTokens, eventId);
        if (token) {
          consolidationMints.add(token.mint);
          if (finding.code === 'DEL_CHAIN_BREAK') brokenEventIds.add(eventId);
        }
      }
    }
  }

  const republishSteps: RepairStep[] = [];
  const rolloverSteps: RepairStep[] = [];
  const deleteSteps: RepairStep[] = [];
  const walletSteps: RepairStep[] = [];
  const actionSteps: RepairStep[] = [];

  const partitionedLive = diagnosis.findings
    .filter((finding) => finding.code === 'RELAY_PARTITION')
    .flatMap((finding) => finding.eventIds);
  for (const eventId of [...new Set(partitionedLive)].sort()) {
    const token = findToken(merged.liveTokens, merged.naiveLiveTokens, eventId);
    if (!token || consolidationMints.has(token.mint)) continue;
    const lacking = okRelays.filter((url) => !token.seenOn.includes(url));
    if (lacking.length === 0) continue;
    republishSteps.push({ action: 'republish_event', eventId, toRelays: lacking });
  }

  let rolloverIndex = 0;
  for (const mint of [...consolidationMints].sort()) {
    const liveForMint = merged.liveTokens.filter((token) => token.mint === mint);
    const brokenForMint = merged.naiveLiveTokens.filter(
      (token) => token.mint === mint && brokenEventIds.has(token.eventId),
    );
    const deleteIds = [
      ...new Set([
        ...liveForMint.map((token) => token.eventId),
        ...brokenForMint.map((token) => token.eventId),
      ]),
    ].sort();
    if (deleteIds.length === 0) continue;
    const coveredYs = [
      ...new Set(
        liveForMint.flatMap((token) =>
          token.proofs
            .filter((proof) => COVERED_STATES.has(mintByY.get(proof.y)?.state ?? 'SPENT'))
            .map((proof) => proof.y),
        ),
      ),
    ].sort();
    const unit = liveForMint[0]?.unit ?? 'sat';
    if (coveredYs.length > 0) {
      rolloverSteps.push({
        action: 'publish_rollover',
        rolloverId: `planned:rollover:${rolloverIndex}`,
        mint,
        unit,
        coveredYs,
        del: deleteIds,
        toRelays: okRelays,
      });
      rolloverIndex += 1;
    }
    deleteSteps.push({ action: 'delete_events', eventIds: deleteIds, toRelays: okRelays });
  }

  const forkFindings = diagnosis.findings.filter((finding) => finding.code === 'WALLET_EVENT_FORK');
  if (forkFindings.length > 0 && merged.walletEvent !== null) {
    const staleRelays = [
      ...new Set(
        forkFindings.flatMap((finding) =>
          finding.relays.filter((url) => url !== merged.walletEvent?.eventId),
        ),
      ),
    ].sort();
    if (staleRelays.length > 0) {
      walletSteps.push({
        action: 'republish_wallet_event',
        eventId: merged.walletEvent.eventId,
        toRelays: staleRelays,
      });
    }
  }

  for (const finding of diagnosis.findings.filter(isOrphanFinding)) {
    const mint = orphanMint(finding, observation.mint);
    if (mint === null) continue;
    actionSteps.push({ action: 'wallet_action', kind: 'nut09_restore', mint, ys: finding.ys });
  }

  return {
    schemaVersion: 1,
    subject: observation.subject,
    captureDigest: input.captureDigest,
    steps: [...republishSteps, ...rolloverSteps, ...deleteSteps, ...walletSteps, ...actionSteps],
  };
}

function isOrphanFinding(finding: Finding): boolean {
  return finding.code === 'ORPHANED_PROOFS';
}

function orphanMint(finding: Finding, mint: readonly MintObservation[]): string | null {
  const y = finding.ys[0];
  if (y === undefined) return null;
  return mint.find((entry) => entry.y === y)?.mint ?? null;
}

function findToken(
  liveTokens: readonly TokenEventView[],
  naiveLiveTokens: readonly TokenEventView[],
  eventId: string,
): TokenEventView | undefined {
  return (
    liveTokens.find((token) => token.eventId === eventId) ??
    naiveLiveTokens.find((token) => token.eventId === eventId)
  );
}

export { eventYs };
