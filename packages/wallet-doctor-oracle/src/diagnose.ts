import {
  reconstruct,
  indexMintTruth,
  mintProofKey,
  type DoctorObservation,
  type MergedView,
  type MintObservation,
  type RelayView,
  type TokenEventView,
} from '@cashu-fault-lab/wallet-doctor-core';

export const DIAGNOSIS_CODES = [
  'RELAY_PARTITION',
  'GHOST_TOKEN',
  'ORPHANED_PROOFS',
  'DEL_CHAIN_BREAK',
  'WALLET_EVENT_FORK',
  'DELETION_NOT_PROPAGATED',
  'HISTORY_GAP',
  'QUOTE_LIMBO',
  'MALFORMED_EVENT',
] as const;

export type DiagnosisCode = (typeof DIAGNOSIS_CODES)[number];

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  readonly code: DiagnosisCode;
  readonly severity: Severity;
  /** Deterministic human-readable explanation. */
  readonly summary: string;
  /** Relay urls involved (present/lacking/stale depending on the code). */
  readonly relays: readonly string[];
  /** Token/wallet event ids involved. */
  readonly eventIds: readonly string[];
  /** Proof `y` values involved. */
  readonly ys: readonly string[];
  /** Mint identity when the finding is scoped to exactly one mint. */
  readonly mint?: string;
  /** Sats shown-but-gone, double-counted, or recoverable, when applicable. */
  readonly amountAtRisk: number;
}

export interface RelayBalance {
  readonly url: string;
  readonly status: 'ok' | 'error';
  readonly balance: number;
}

/** Explains exactly why two applications disagree about one wallet's balance. */
export interface BalanceExplanation {
  readonly perRelay: readonly RelayBalance[];
  /** What a naive multi-relay reader could count (duplicates included). */
  readonly naiveMerged: number;
  /** Globally live events after deletion and del-chain rules. */
  readonly merged: number;
  /** UNSPENT-at-mint value referenced by live events plus orphaned proofs. */
  readonly mintVerified: number;
  /** `naiveMerged` minus unique-proof sum (the double-counted part). */
  readonly doubleCounted: number;
  /** Value in live events whose proofs the mint reports SPENT. */
  readonly ghost: number;
  /** UNSPENT value no live event references (recoverable via NUT-09). */
  readonly orphanedUnspent: number;
}

export interface Diagnosis {
  readonly subject: string;
  readonly findings: readonly Finding[];
  readonly balance: BalanceExplanation;
  /** True when no error-severity finding was emitted. */
  readonly ok: boolean;
}

export interface DiagnoseOptions {
  /** Reference time (unix seconds) for quote-expiration checks; deterministic. */
  readonly now?: number;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const MAXIMUM_FINDING_SUMMARY_LENGTH = 8192;

function sumAmounts(tokens: readonly TokenEventView[]): number {
  return tokens.reduce(
    (total, token) => total + token.proofs.reduce((sum, proof) => sum + proof.amount, 0),
    0,
  );
}

function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severity !== 0) return severity;
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    const event = (a.eventIds[0] ?? '').localeCompare(b.eventIds[0] ?? '');
    if (event !== 0) return event;
    return (a.ys[0] ?? '').localeCompare(b.ys[0] ?? '');
  });
}

/**
 * Run every diagnosis rule over one observation. The oracle consumes only the
 * normalized relay observations and mint truth; it never contacts a relay,
 * mint, or wallet itself.
 */
export function diagnose(observation: DoctorObservation, options: DiagnoseOptions = {}): Diagnosis {
  const { perRelay, merged } = reconstruct(observation);
  const mintByY = indexMintTruth(observation.mint);
  const okRelayUrls = observation.relays
    .filter((relay) => relay.status === 'ok')
    .map((relay) => relay.url)
    .sort();
  const findings: Finding[] = [];

  findings.push(...relayPartitions(merged, okRelayUrls));
  findings.push(...ghostTokens(merged, mintByY));
  findings.push(...orphanedProofs(merged, mintByY));
  findings.push(...delChainBreaks(merged, perRelay));
  findings.push(...walletEventForks(observation, perRelay, merged, okRelayUrls));
  findings.push(...deletionsNotPropagated(observation, merged, perRelay));
  findings.push(...historyGaps(observation));
  findings.push(...quoteLimbo(observation, options.now ?? 0));
  findings.push(...malformedEvents(observation));

  const boundedFindings = findings.map((finding) => ({
    ...finding,
    summary: finding.summary.slice(0, MAXIMUM_FINDING_SUMMARY_LENGTH),
  }));

  return {
    subject: observation.subject,
    findings: sortFindings(boundedFindings),
    balance: explainBalance(perRelay, merged, mintByY),
    ok: boundedFindings.every((finding) => finding.severity !== 'error'),
  };
}

function relayPartitions(merged: MergedView, okRelayUrls: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const token of merged.liveTokens) {
    const present = token.seenOn.filter((url) => okRelayUrls.includes(url));
    const absent = okRelayUrls.filter((url) => !token.seenOn.includes(url));
    if (present.length === 0 || absent.length === 0) continue;
    findings.push({
      code: 'RELAY_PARTITION',
      severity: 'warning',
      summary: `token event ${token.eventId} is served by ${present.length} of ${okRelayUrls.length} relays; applications reading only ${absent.join(', ')} never see it`,
      relays: [...present, ...absent],
      eventIds: [token.eventId],
      ys: token.proofs.map((proof) => proof.y),
      amountAtRisk: sumAmounts([token]),
    });
  }
  return findings;
}

function ghostTokens(merged: MergedView, mintByY: ReadonlyMap<string, MintObservation>): Finding[] {
  const findings: Finding[] = [];
  for (const token of merged.liveTokens) {
    if (token.proofs.length === 0) continue;
    const states = token.proofs.map(
      (proof) => mintByY.get(mintProofKey(token.mint, proof.y))?.state,
    );
    if (states.some((state) => state === undefined)) continue;
    const spentYs = token.proofs
      .filter((proof) => mintByY.get(mintProofKey(token.mint, proof.y))?.state === 'SPENT')
      .map((proof) => proof.y);
    if (spentYs.length === 0) continue;
    const ghostAmount = token.proofs
      .filter((proof) => mintByY.get(mintProofKey(token.mint, proof.y))?.state === 'SPENT')
      .reduce((total, proof) => total + proof.amount, 0);
    findings.push({
      code: 'GHOST_TOKEN',
      severity: 'error',
      summary: `token event ${token.eventId} is live on ${token.seenOn.join(', ')} but ${spentYs.length} of ${token.proofs.length} proof(s) are SPENT at ${token.mint}; applications show ${ghostAmount} sats that are gone`,
      relays: [...token.seenOn],
      eventIds: [token.eventId],
      ys: spentYs.sort(),
      amountAtRisk: ghostAmount,
    });
  }
  return findings;
}

function orphanedProofs(
  merged: MergedView,
  mintByY: ReadonlyMap<string, MintObservation>,
): Finding[] {
  const byMint = new Map<string, { ys: string[]; eventIds: Set<string>; amount: number }>();
  for (const orphan of merged.orphanCandidates) {
    if (mintByY.get(mintProofKey(orphan.mint, orphan.y))?.state !== 'UNSPENT') continue;
    const entry = byMint.get(orphan.mint) ?? { ys: [], eventIds: new Set<string>(), amount: 0 };
    entry.ys.push(orphan.y);
    for (const eventId of orphan.lastSeenIn) entry.eventIds.add(eventId);
    entry.amount += orphan.amount;
    byMint.set(orphan.mint, entry);
  }
  return [...byMint.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mint, entry]) => ({
      code: 'ORPHANED_PROOFS' as const,
      severity: 'error' as const,
      summary: `${entry.ys.length} proof(s) worth ${entry.amount} sats are UNSPENT at ${mint} but no live token event references them; a deletion or rollover reached the relays without its successor`,
      relays: [],
      eventIds: [...entry.eventIds].sort(),
      ys: entry.ys.sort(),
      mint,
      amountAtRisk: entry.amount,
    }));
}

function delChainBreaks(merged: MergedView, perRelay: readonly RelayView[]): Finding[] {
  const liveEventIds = new Set(merged.liveTokens.map((token) => token.eventId));
  const superseded = new Set(merged.supersededAnywhere);
  const findings: Finding[] = [];
  for (const token of merged.naiveLiveTokens) {
    if (liveEventIds.has(token.eventId)) continue;
    // Only a seen `del` reference proves supersession. A plain kind:5 deletion
    // that reached only some relays produces the same live/not-live pattern and
    // belongs to DELETION_NOT_PROPAGATED, not here.
    if (!superseded.has(token.eventId)) continue;
    const stillLiveOn = perRelay
      .filter((view) => view.liveTokens.some((live) => live.eventId === token.eventId))
      .map((view) => view.url)
      .sort();
    if (stillLiveOn.length === 0) continue;
    findings.push({
      code: 'DEL_CHAIN_BREAK',
      severity: 'error',
      summary: `token event ${token.eventId} was rolled over but its deletion never reached ${stillLiveOn.join(', ')}; a naive merge counts its proofs twice`,
      relays: stillLiveOn,
      eventIds: [token.eventId],
      ys: token.proofs.map((proof) => proof.y),
      amountAtRisk: sumAmounts([token]),
    });
  }
  return findings;
}

function walletEventForks(
  observation: DoctorObservation,
  perRelay: readonly RelayView[],
  merged: MergedView,
  okRelayUrls: readonly string[],
): Finding[] {
  const global = merged.walletEvent;
  if (global === null) {
    if (okRelayUrls.length === 0) return [];
    return [
      {
        code: 'WALLET_EVENT_FORK',
        severity: 'error',
        summary: `relays ${okRelayUrls.join(', ')} serve no kind:17375 wallet event; applications do not recognize the wallet`,
        relays: [...okRelayUrls],
        eventIds: [],
        ys: [],
        amountAtRisk: 0,
      },
    ];
  }
  const stale = perRelay
    .filter(
      (view) =>
        view.status === 'ok' &&
        view.walletEvent !== null &&
        view.walletEvent.eventId !== global.eventId,
    )
    .map((view) => view.url)
    .sort();
  const missing = observation.relays
    .filter((relay) => relay.status === 'ok' && relay.wallet.length === 0)
    .map((relay) => relay.url)
    .sort();
  const findings: Finding[] = [];
  if (stale.length > 0) {
    const staleIds = perRelay
      .filter((view) => stale.includes(view.url) && view.walletEvent !== null)
      .map((view) => view.walletEvent?.eventId ?? '')
      .filter((id) => id !== '')
      .sort();
    findings.push({
      code: 'WALLET_EVENT_FORK',
      severity: 'error',
      summary: `relays ${stale.join(', ')} serve a stale kind:17375 wallet event instead of ${global.eventId}; applications may use different mint sets or fail to recognize the wallet`,
      relays: stale,
      eventIds: [global.eventId, ...staleIds],
      ys: [],
      amountAtRisk: 0,
    });
  }
  if (missing.length > 0 && okRelayUrls.length > missing.length) {
    findings.push({
      code: 'WALLET_EVENT_FORK',
      severity: 'error',
      summary: `relays ${missing.join(', ')} serve no kind:17375 wallet event while others serve ${global.eventId}; applications reading only those relays do not recognize the wallet`,
      relays: missing,
      eventIds: [global.eventId],
      ys: [],
      amountAtRisk: 0,
    });
  }
  return findings;
}

function deletionsNotPropagated(
  observation: DoctorObservation,
  merged: MergedView,
  perRelay: readonly RelayView[],
): Finding[] {
  // Any seen successor's `del` owns the case, even when that successor is not
  // naive-live itself (e.g. it is deleted on the only relay serving it).
  const superseded = new Set(merged.supersededAnywhere);
  const findings: Finding[] = [];
  for (const relay of observation.relays) {
    if (relay.status !== 'ok') continue;
    for (const deletion of relay.deletions) {
      for (const target of deletion.targets) {
        if (superseded.has(target)) continue; // del-chain rule owns this case
        if (merged.liveTokens.some((token) => token.eventId === target)) continue;
        const stillLiveOn = perRelay
          .filter(
            (view) =>
              view.url !== relay.url && view.liveTokens.some((live) => live.eventId === target),
          )
          .map((view) => view.url)
          .sort();
        if (stillLiveOn.length === 0) continue;
        findings.push({
          code: 'DELETION_NOT_PROPAGATED',
          severity: 'warning',
          summary: `kind:5 deletion ${deletion.eventId} reached ${relay.url} but ${stillLiveOn.join(', ')} still serve ${target} as live; balances flap between applications`,
          relays: [relay.url, ...stillLiveOn],
          eventIds: [deletion.eventId, target],
          ys: [],
          amountAtRisk: 0,
        });
      }
    }
  }
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = finding.eventIds[1] ?? '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function historyGaps(observation: DoctorObservation): Finding[] {
  // A reference is unknown only when the capture carries no evidence the event
  // ever existed on these relays: neither a served token event (live or not)
  // nor a NIP-09 deletion targeting it. Destroyed predecessors are normally
  // pruned by relays once their deletion lands, so their absence from the
  // token set must not read as a gap.
  const knownIds = new Set<string>();
  for (const relay of observation.relays) {
    if (relay.status !== 'ok') continue;
    for (const token of relay.tokens) knownIds.add(token.eventId);
    for (const deletion of relay.deletions) {
      for (const target of deletion.targets) knownIds.add(target);
    }
  }
  const unknown = new Set<string>();
  for (const relay of observation.relays) {
    if (relay.status !== 'ok') continue;
    for (const history of relay.history) {
      for (const reference of [...history.created, ...history.destroyed, ...history.redeemed]) {
        if (!knownIds.has(reference)) unknown.add(reference);
      }
    }
  }
  if (unknown.size === 0) return [];
  return [
    {
      code: 'HISTORY_GAP',
      severity: 'info',
      summary: `spending history references ${unknown.size} unknown token event(s); transaction history is incomplete or inconsistent with relay token state`,
      relays: [],
      eventIds: [...unknown].sort(),
      ys: [],
      amountAtRisk: 0,
    },
  ];
}

function quoteLimbo(observation: DoctorObservation, now: number): Finding[] {
  const pending = observation.relays
    .filter((relay) => relay.status === 'ok')
    .flatMap((relay) => relay.quotes)
    .filter((quote) => quote.expiration === null || quote.expiration > now);
  if (pending.length === 0) return [];
  const ids = [...new Set(pending.map((quote) => quote.eventId))].sort();
  return [
    {
      code: 'QUOTE_LIMBO',
      severity: 'info',
      summary: `${ids.length} unexpired kind:7374 quote event(s) sit on relays; a minting wallet may be waiting on quotes another application cannot see complete`,
      relays: [],
      eventIds: ids,
      ys: [],
      amountAtRisk: 0,
    },
  ];
}

function malformedEvents(observation: DoctorObservation): Finding[] {
  const findings: Finding[] = [];
  for (const relay of observation.relays) {
    for (const malformed of relay.malformed) {
      const critical = malformed.kind === 17375 || malformed.kind === 7375;
      findings.push({
        code: 'MALFORMED_EVENT',
        severity: critical ? 'error' : 'warning',
        summary: `${malformed.kind === null ? 'event' : `kind:${malformed.kind} event`} ${malformed.eventId ?? '(unparseable)'} on ${relay.url}: ${malformed.reason}`,
        relays: [relay.url],
        eventIds: malformed.eventId === null ? [] : [malformed.eventId],
        ys: [],
        amountAtRisk: 0,
      });
    }
  }
  return findings;
}

function explainBalance(
  perRelay: readonly RelayView[],
  merged: MergedView,
  mintByY: ReadonlyMap<string, MintObservation>,
): BalanceExplanation {
  let mintVerified = 0;
  let ghost = 0;
  for (const token of merged.liveTokens) {
    for (const proof of token.proofs) {
      const state = mintByY.get(mintProofKey(token.mint, proof.y))?.state;
      if (state === 'UNSPENT') mintVerified += proof.amount;
      if (state === 'SPENT') ghost += proof.amount;
    }
  }
  let orphanedUnspent = 0;
  for (const orphan of merged.orphanCandidates) {
    if (mintByY.get(mintProofKey(orphan.mint, orphan.y))?.state === 'UNSPENT') {
      orphanedUnspent += orphan.amount;
    }
  }
  return {
    perRelay: perRelay.map((view) => ({
      url: view.url,
      status: view.status,
      balance: view.balance,
    })),
    naiveMerged: merged.naiveBalance,
    merged: merged.balance,
    mintVerified: mintVerified + orphanedUnspent,
    doubleCounted: merged.doubleCounted,
    ghost,
    orphanedUnspent,
  };
}
