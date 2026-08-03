import type {
  DoctorObservation,
  MintObservation,
  ProofView,
  RelayObservation,
  TokenEventView,
  WalletEventView,
} from './types.js';

/** What one application would reconstruct reading only this relay. */
export interface RelayView {
  readonly url: string;
  readonly status: 'ok' | 'error';
  /** Latest wallet event this relay serves (replaceable semantics). */
  readonly walletEvent: WalletEventView | null;
  /** Token events the relay serves that it does not also serve a deletion for. */
  readonly liveTokens: readonly TokenEventView[];
  /** Sum of proof amounts across `liveTokens`. */
  readonly balance: number;
}

/** A proof referenced by more than one live token event in the naive view. */
export interface DuplicateProof {
  readonly y: string;
  readonly amount: number;
  readonly eventIds: readonly string[];
}

/** A proof seen only in deleted/superseded events and absent from all live ones. */
export interface OrphanCandidate {
  readonly y: string;
  readonly keysetId: string;
  readonly amount: number;
  readonly mint: string;
  /** Deleted or superseded events that last referenced the proof. */
  readonly lastSeenIn: readonly string[];
}

export interface MergedView {
  /** Latest wallet event across all relays by created_at, tie-broken by id. */
  readonly walletEvent: WalletEventView | null;
  /** Events not deleted anywhere and not listed in any seen event's `del`. */
  readonly liveTokens: readonly TokenEventView[];
  /** Union of per-relay live tokens (deduplicated by event id). */
  readonly naiveLiveTokens: readonly TokenEventView[];
  /** Sum across `liveTokens` (no event shares a proof after del-chain rules). */
  readonly balance: number;
  /** Sum across `naiveLiveTokens`; may count one proof twice. */
  readonly naiveBalance: number;
  /** `naiveBalance` minus the sum over unique proofs in `naiveLiveTokens`. */
  readonly doubleCounted: number;
  readonly duplicateProofs: readonly DuplicateProof[];
  /** Event ids listed in any seen token event's `del` (superseded somewhere), sorted. */
  readonly supersededAnywhere: readonly string[];
  /** Proofs that disappeared from every live event; mint truth classifies them. */
  readonly orphanCandidates: readonly OrphanCandidate[];
}

export interface Reconstruction {
  readonly perRelay: readonly RelayView[];
  readonly merged: MergedView;
}

function sumProofs(proofs: readonly ProofView[]): number {
  return proofs.reduce((total, proof) => total + proof.amount, 0);
}

function sumTokens(tokens: readonly TokenEventView[]): number {
  return tokens.reduce((total, token) => total + sumProofs(token.proofs), 0);
}

/** Deduplicate events by id, merging their `seenOn` relay lists. */
export function dedupeEvents<T extends { eventId: string; seenOn: readonly string[] }>(
  events: readonly T[],
): T[] {
  const byId = new Map<string, { event: T; seen: Set<string> }>();
  for (const event of events) {
    const existing = byId.get(event.eventId);
    if (existing) {
      for (const url of event.seenOn) existing.seen.add(url);
    } else {
      byId.set(event.eventId, { event, seen: new Set(event.seenOn) });
    }
  }
  return [...byId.values()].map(({ event, seen }) => ({
    ...event,
    seenOn: [...seen].sort(),
  }));
}

function latestWalletEvent(events: readonly WalletEventView[]): WalletEventView | null {
  let latest: WalletEventView | null = null;
  for (const event of events) {
    if (
      latest === null ||
      event.createdAt > latest.createdAt ||
      (event.createdAt === latest.createdAt && event.eventId > latest.eventId)
    ) {
      latest = event;
    }
  }
  return latest;
}

/** Reconstruct the view one relay gives an application. */
export function reconstructRelay(relay: RelayObservation): RelayView {
  if (relay.status !== 'ok') {
    return { url: relay.url, status: 'error', walletEvent: null, liveTokens: [], balance: 0 };
  }
  const deletedHere = new Set(relay.deletions.flatMap((deletion) => deletion.targets));
  const liveTokens = relay.tokens.filter((token) => !deletedHere.has(token.eventId));
  return {
    url: relay.url,
    status: 'ok',
    walletEvent: latestWalletEvent(relay.wallet),
    liveTokens,
    balance: sumTokens(liveTokens),
  };
}

/**
 * Merge per-relay observations with global NIP-09 deletion sets and NIP-60
 * `del`-chain semantics. A token event is superseded when any seen event lists
 * it in `del`, because its proofs were rolled over at the successor's creation;
 * mint truth then decides whether the successor chain kept them.
 */
export function reconstructMerged(relays: readonly RelayObservation[]): MergedView {
  const okRelays = relays.filter((relay) => relay.status === 'ok');

  const allTokens = dedupeEvents(okRelays.flatMap((relay) => relay.tokens));
  const allWallet = dedupeEvents(okRelays.flatMap((relay) => relay.wallet));
  const deletedAnywhere = new Set(
    okRelays.flatMap((relay) => relay.deletions.flatMap((deletion) => deletion.targets)),
  );
  const supersededAnywhere = new Set(allTokens.flatMap((token) => token.del));

  const liveTokens = allTokens.filter(
    (token) => !deletedAnywhere.has(token.eventId) && !supersededAnywhere.has(token.eventId),
  );

  const relayViews = okRelays.map((relay) => reconstructRelay(relay));
  const naiveLiveTokens = dedupeEvents(relayViews.flatMap((view) => view.liveTokens));

  const proofOwners = new Map<string, { proof: ProofView; eventIds: string[] }>();
  for (const token of naiveLiveTokens) {
    for (const proof of token.proofs) {
      const existing = proofOwners.get(proof.y);
      if (existing) {
        if (!existing.eventIds.includes(token.eventId)) {
          existing.eventIds.push(token.eventId);
        }
      } else {
        proofOwners.set(proof.y, { proof, eventIds: [token.eventId] });
      }
    }
  }
  const duplicateProofs: DuplicateProof[] = [...proofOwners.entries()]
    .filter(([, owner]) => owner.eventIds.length > 1)
    .map(([y, owner]) => ({
      y,
      amount: owner.proof.amount,
      eventIds: [...owner.eventIds].sort(),
    }))
    .sort((a, b) => a.y.localeCompare(b.y));

  const naiveBalance = sumTokens(naiveLiveTokens);
  const uniqueBalance = [...proofOwners.values()].reduce(
    (total, owner) => total + owner.proof.amount,
    0,
  );

  const liveYs = new Set(liveTokens.flatMap((token) => token.proofs.map((proof) => proof.y)));
  const liveEventIds = new Set(liveTokens.map((token) => token.eventId));
  const orphanByY = new Map<string, OrphanCandidate & { lastSeen: Set<string> }>();
  for (const token of allTokens) {
    if (liveEventIds.has(token.eventId)) continue;
    for (const proof of token.proofs) {
      if (liveYs.has(proof.y)) continue;
      const existing = orphanByY.get(proof.y);
      if (existing) {
        existing.lastSeen.add(token.eventId);
      } else {
        orphanByY.set(proof.y, {
          y: proof.y,
          keysetId: proof.keysetId,
          amount: proof.amount,
          mint: token.mint,
          lastSeen: new Set([token.eventId]),
          lastSeenIn: [],
        });
      }
    }
  }
  const orphanCandidates: OrphanCandidate[] = [...orphanByY.values()]
    .map(({ lastSeen, ...candidate }) => ({
      ...candidate,
      lastSeenIn: [...lastSeen].sort(),
    }))
    .sort((a, b) => a.y.localeCompare(b.y));

  return {
    walletEvent: latestWalletEvent(allWallet),
    liveTokens,
    naiveLiveTokens,
    balance: sumTokens(liveTokens),
    naiveBalance,
    doubleCounted: naiveBalance - uniqueBalance,
    duplicateProofs,
    supersededAnywhere: [...supersededAnywhere].sort(),
    orphanCandidates,
  };
}

export function reconstruct(observation: DoctorObservation): Reconstruction {
  return {
    perRelay: observation.relays.map((relay) => reconstructRelay(relay)),
    merged: reconstructMerged(observation.relays),
  };
}

/** Index mint observations by proof `y` for lookup during diagnosis. */
export function indexMintTruth(
  mint: readonly MintObservation[],
): ReadonlyMap<string, MintObservation> {
  const byY = new Map<string, MintObservation>();
  for (const observation of mint) {
    byY.set(observation.y, observation);
  }
  return byY;
}
