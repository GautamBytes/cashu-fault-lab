import { createHash } from 'node:crypto';
import { getPublicKey, nip44, type Event } from 'nostr-tools';
import type {
  HistoryEventView,
  MalformedEventView,
  MintObservation,
  QuoteEventView,
  RelayObservation,
  TokenEventView,
  WalletEventView,
} from '@cashu-fault-lab/wallet-doctor-core';
import { fetchNip60Events } from './relay-client.js';
import { checkProofStates } from './mint-client.js';
import {
  normalizeDeletionEvent,
  normalizeHistoryEvent,
  normalizeQuoteEvent,
  normalizeTokenPayload,
  normalizeWalletPayload,
  parseJson,
} from './normalize.js';
import type { Nip60Capture, RelayCaptureEvidence } from './types.js';

export interface CaptureOptions {
  /** Relay urls to read (order preserved in the bundle). */
  readonly relays: readonly string[];
  /** Decoded subject secret key; enables decryption of wallet content. */
  readonly subjectSecretKey?: Uint8Array;
  /** Subject hex pubkey; required when no secret key is provided. */
  readonly subjectPubkey?: string;
  readonly timeoutMs?: number;
  /** Overall capture deadline across every relay and mint request. */
  readonly overallTimeoutMs?: number;
  /** Test-only/local-lab escape hatch for loopback HTTP and WS endpoints. */
  readonly allowInsecureLoopback?: boolean;
  /** ISO timestamp override for deterministic captures (tests/replay). */
  readonly capturedAt?: string;
  /** Test hooks replacing transport. */
  readonly fetchEvents?: typeof fetchNip60Events;
  readonly checkStates?: typeof checkProofStates;
}

export const CAPTURE_DIGEST_DOMAIN = 'cashu-fault-lab/nip60-capture-v2';
const MAXIMUM_CAPTURE_PROOFS = 10_000;
const MAXIMUM_CAPTURE_EVENTS = 10_000;
const MAXIMUM_CAPTURE_MINTS = 64;
const MAXIMUM_CAPTURE_RELAYS = 64;
const MAXIMUM_CAPTURE_CONTENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_OVERALL_TIMEOUT_MS = 60_000;

/** Stable JSON: object keys sorted recursively, arrays preserved. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function captureDigest(bundle: Omit<Nip60Capture, 'digest'>): string {
  const hash = createHash('sha256');
  hash.update(CAPTURE_DIGEST_DOMAIN, 'utf8');
  hash.update('\0');
  hash.update(canonicalJson(bundle), 'utf8');
  return `sha256:${hash.digest('hex')}`;
}

interface NormalizedRelay {
  readonly observation: RelayObservation;
  readonly evidence: RelayCaptureEvidence;
}

interface CaptureBudget {
  eventCount: number;
  proofCandidates: number;
  contentBytes: number;
}

type CollectedRelay =
  | { readonly ok: true; readonly url: string; readonly events: readonly Event[] }
  | { readonly ok: false; readonly url: string; readonly error: string };

function consumeEventBudget(events: readonly Event[], budget: CaptureBudget): void {
  for (const event of events) {
    budget.eventCount += 1;
    budget.contentBytes += Buffer.byteLength(event.content, 'utf8');
    if (budget.eventCount > MAXIMUM_CAPTURE_EVENTS) {
      throw new Error(`capture event count exceeds ${MAXIMUM_CAPTURE_EVENTS}`);
    }
    if (budget.contentBytes > MAXIMUM_CAPTURE_CONTENT_BYTES) {
      throw new Error(`capture encrypted content exceeds ${MAXIMUM_CAPTURE_CONTENT_BYTES} bytes`);
    }
  }
}

function decryptEvent(event: Event, conversationKey: Uint8Array | null): string | null {
  if (conversationKey === null) return null;
  try {
    return nip44.v2.decrypt(event.content, conversationKey);
  } catch {
    return null;
  }
}

function preflightProofCandidates(
  relays: readonly CollectedRelay[],
  conversationKey: Uint8Array | null,
  budget: CaptureBudget,
): void {
  for (const relay of relays) {
    if (!relay.ok) continue;
    for (const event of relay.events) {
      if (event.kind !== 7375) continue;
      const plaintext = decryptEvent(event, conversationKey);
      if (plaintext === null) continue;
      const payload = parseJson(plaintext);
      const candidateCount =
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        Array.isArray((payload as { proofs?: unknown }).proofs)
          ? (payload as { proofs: unknown[] }).proofs.length
          : 0;
      budget.proofCandidates += candidateCount;
      if (budget.proofCandidates > MAXIMUM_CAPTURE_PROOFS) {
        throw new Error(`capture proof candidate count exceeds ${MAXIMUM_CAPTURE_PROOFS}`);
      }
    }
  }
}

function byEventId(
  a: { readonly eventId: string | null },
  b: { readonly eventId: string | null },
): number {
  return (a.eventId ?? '').localeCompare(b.eventId ?? '');
}

function normalizeRelayEvents(
  url: string,
  events: readonly Event[],
  conversationKey: Uint8Array | null,
): NormalizedRelay {
  const wallet: WalletEventView[] = [];
  const tokens: TokenEventView[] = [];
  const history: HistoryEventView[] = [];
  const quotes: QuoteEventView[] = [];
  const malformed: MalformedEventView[] = [];
  const deletions = events
    .filter((event) => event.kind === 5)
    .flatMap((event) => {
      const result = normalizeDeletionEvent(event, [url]);
      return result.ok ? [result.view] : [];
    });

  for (const event of events) {
    if (event.kind === 5) continue;
    if (event.kind === 7374) {
      const quote = normalizeQuoteEvent(event, [url]);
      if (quote.ok) quotes.push(quote.view);
      continue;
    }
    const plaintext = decryptEvent(event, conversationKey);
    if (plaintext === null) {
      malformed.push({
        eventId: event.id,
        kind: event.kind,
        reason: 'decryption_failed',
        seenOn: [url],
      });
      continue;
    }
    const payload = parseJson(plaintext);
    if (event.kind === 17375) {
      const result = normalizeWalletPayload(event, payload, [url]);
      if (result.ok) wallet.push(result.view);
      else
        malformed.push({
          eventId: event.id,
          kind: event.kind,
          reason: result.reason,
          seenOn: [url],
        });
    } else if (event.kind === 7375) {
      const result = normalizeTokenPayload(event, payload, [url]);
      if (result.ok) tokens.push(result.view);
      else
        malformed.push({
          eventId: event.id,
          kind: event.kind,
          reason: result.reason,
          seenOn: [url],
        });
    } else if (event.kind === 7376) {
      const result = normalizeHistoryEvent(event, payload, [url]);
      if (result.ok) history.push(result.view);
      else
        malformed.push({
          eventId: event.id,
          kind: event.kind,
          reason: result.reason,
          seenOn: [url],
        });
    }
    // Other kinds authored by the subject are ignored by design.
  }

  return {
    observation: {
      url,
      status: 'ok',
      error: null,
      wallet: wallet.sort(byEventId),
      tokens: tokens.sort(byEventId),
      deletions: deletions.sort(byEventId),
      history: history.sort(byEventId),
      quotes: quotes.sort(byEventId),
      malformed: malformed.sort(byEventId),
    },
    evidence: {
      url,
      status: 'ok',
      error: null,
      eventIds: events.map((event) => event.id).sort(),
    },
  };
}

/**
 * Collect one subject's NIP-60 state from several relays, normalize it with
 * proof secrets dropped, and verify every discovered proof against its mint.
 * Transport never writes to a relay; the only network calls are REQ fetches
 * and NUT-07 checkstate POSTs.
 */
export async function captureWallet(options: CaptureOptions): Promise<Nip60Capture> {
  const fetchImpl = options.fetchEvents ?? fetchNip60Events;
  const checkImpl = options.checkStates ?? checkProofStates;
  const subject =
    options.subjectSecretKey !== undefined
      ? getPublicKey(options.subjectSecretKey)
      : options.subjectPubkey;
  if (subject === undefined || !/^[0-9a-f]{64}$/u.test(subject)) {
    throw new Error('A 64-hex-character subject pubkey or secret key is required');
  }
  if (
    options.relays.length === 0 ||
    options.relays.length > MAXIMUM_CAPTURE_RELAYS ||
    new Set(options.relays).size !== options.relays.length
  ) {
    throw new Error(`capture requires 1-${MAXIMUM_CAPTURE_RELAYS} unique relay URLs`);
  }
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(overallTimeoutMs) ||
    overallTimeoutMs < 100 ||
    overallTimeoutMs > 600_000
  ) {
    throw new Error('overall capture timeout must be an integer from 100 to 600000 milliseconds');
  }
  const deadline = Date.now() + overallTimeoutMs;
  const remainingTimeout = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('capture exceeded its overall timeout');
    return Math.min(options.timeoutMs ?? 10_000, remaining);
  };
  const conversationKey =
    options.subjectSecretKey !== undefined
      ? nip44.v2.utils.getConversationKey(options.subjectSecretKey, subject)
      : null;

  const collectedRelays: CollectedRelay[] = [];
  const budget: CaptureBudget = {
    eventCount: 0,
    proofCandidates: 0,
    contentBytes: 0,
  };
  for (const url of options.relays) {
    let events: readonly Event[];
    try {
      events = await fetchImpl(url, subject, remainingTimeout(), {
        allowInsecureLoopback: options.allowInsecureLoopback ?? false,
        maxEvents: MAXIMUM_CAPTURE_EVENTS - budget.eventCount,
        maxContentBytes: MAXIMUM_CAPTURE_CONTENT_BYTES - budget.contentBytes,
        maxWireBytes: Math.min(
          32 * 1024 * 1024,
          MAXIMUM_CAPTURE_CONTENT_BYTES - budget.contentBytes + 8 * 1024 * 1024,
        ),
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'relay query failed').slice(0, 512);
      collectedRelays.push({
        ok: false,
        url,
        error: message,
      });
      continue;
    }
    const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()];
    consumeEventBudget(uniqueEvents, budget);
    collectedRelays.push({ ok: true, url, events: uniqueEvents });
  }

  // Reject aggregate proof work before hash-to-curve normalization begins.
  preflightProofCandidates(collectedRelays, conversationKey, budget);

  const relays: RelayObservation[] = [];
  const relayEvidence: RelayCaptureEvidence[] = [];
  for (const relay of collectedRelays) {
    if (!relay.ok) {
      relays.push({
        url: relay.url,
        status: 'error',
        error: relay.error,
        wallet: [],
        tokens: [],
        deletions: [],
        history: [],
        quotes: [],
        malformed: [],
      });
      relayEvidence.push({
        url: relay.url,
        status: 'error',
        error: relay.error,
        eventIds: [],
      });
      continue;
    }
    const normalized = normalizeRelayEvents(relay.url, relay.events, conversationKey);
    relays.push(normalized.observation);
    relayEvidence.push(normalized.evidence);
  }

  // Every proof discovered in any token event is checked against its mint.
  const ysByMint = new Map<string, Set<string>>();
  let uniqueProofs = 0;
  for (const relay of relays) {
    for (const token of relay.tokens) {
      const set = ysByMint.get(token.mint) ?? new Set<string>();
      for (const proof of token.proofs) {
        if (!set.has(proof.y)) {
          if (uniqueProofs >= MAXIMUM_CAPTURE_PROOFS) {
            throw new Error(`capture proof count exceeds ${MAXIMUM_CAPTURE_PROOFS}`);
          }
          set.add(proof.y);
          uniqueProofs += 1;
        }
      }
      ysByMint.set(token.mint, set);
    }
  }
  if (ysByMint.size > MAXIMUM_CAPTURE_MINTS) {
    throw new Error(`capture mint count exceeds ${MAXIMUM_CAPTURE_MINTS}`);
  }
  const mint: MintObservation[] = [];
  for (const [mintUrl, ys] of [...ysByMint.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    mint.push(
      ...(await checkImpl(mintUrl, [...ys].sort(), {
        timeoutMs: remainingTimeout(),
        allowInsecureLoopback: options.allowInsecureLoopback ?? false,
      })),
    );
  }

  const bundle: Omit<Nip60Capture, 'digest'> = {
    schemaVersion: 2,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    subject,
    observation: { subject, relays, mint },
    relayEvidence,
    redaction: {
      proofSecretsDropped: true,
      encryptedContentsDropped: true,
      walletPrivateKeyDropped: true,
    },
  };
  const capture = { ...bundle, digest: captureDigest(bundle) };
  const { assertNip60Capture } = await import('./validation.js');
  return assertNip60Capture(capture);
}
