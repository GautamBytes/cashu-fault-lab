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
import type { Nip60Capture, RawRelayCapture } from './types.js';

export interface CaptureOptions {
  /** Relay urls to read (order preserved in the bundle). */
  readonly relays: readonly string[];
  /** Decoded subject secret key; enables decryption of wallet content. */
  readonly subjectSecretKey?: Uint8Array;
  /** Subject hex pubkey; required when no secret key is provided. */
  readonly subjectPubkey?: string;
  readonly timeoutMs?: number;
  /** ISO timestamp override for deterministic captures (tests/replay). */
  readonly capturedAt?: string;
  /** Test hooks replacing transport. */
  readonly fetchEvents?: typeof fetchNip60Events;
  readonly checkStates?: typeof checkProofStates;
}

export const CAPTURE_DIGEST_DOMAIN = 'cashu-fault-lab/nip60-capture-v1';

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
  readonly raw: RawRelayCapture;
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
    .map((event) => normalizeDeletionEvent(event, [url]));

  const decrypt = (event: Event): string | null => {
    if (conversationKey === null) return null;
    try {
      return nip44.v2.decrypt(event.content, conversationKey);
    } catch {
      return null;
    }
  };

  for (const event of events) {
    if (event.kind === 5) continue;
    if (event.kind === 7374) {
      const quote = normalizeQuoteEvent(event, [url]);
      if (quote.ok) quotes.push(quote.view);
      continue;
    }
    const plaintext = decrypt(event);
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
      wallet,
      tokens,
      deletions,
      history,
      quotes,
      malformed,
    },
    raw: { url, status: 'ok', error: null, events },
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
  const conversationKey =
    options.subjectSecretKey !== undefined
      ? nip44.v2.utils.getConversationKey(options.subjectSecretKey, subject)
      : null;

  const relays: RelayObservation[] = [];
  const rawRelays: RawRelayCapture[] = [];
  for (const url of options.relays) {
    let events: readonly Event[];
    try {
      events = await fetchImpl(url, subject, options.timeoutMs ?? 10_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'relay query failed';
      relays.push({
        url,
        status: 'error',
        error: message,
        wallet: [],
        tokens: [],
        deletions: [],
        history: [],
        quotes: [],
        malformed: [],
      });
      rawRelays.push({ url, status: 'error', error: message, events: [] });
      continue;
    }
    const normalized = normalizeRelayEvents(url, events, conversationKey);
    relays.push(normalized.observation);
    rawRelays.push(normalized.raw);
  }

  // Every proof discovered in any token event is checked against its mint.
  const ysByMint = new Map<string, Set<string>>();
  for (const relay of relays) {
    for (const token of relay.tokens) {
      const set = ysByMint.get(token.mint) ?? new Set<string>();
      for (const proof of token.proofs) set.add(proof.y);
      ysByMint.set(token.mint, set);
    }
  }
  const mint: MintObservation[] = [];
  for (const [mintUrl, ys] of [...ysByMint.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    mint.push(
      ...(await checkImpl(mintUrl, [...ys].sort(), { timeoutMs: options.timeoutMs ?? 10_000 })),
    );
  }

  const bundle: Omit<Nip60Capture, 'digest'> = {
    schemaVersion: 1,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    subject,
    observation: { subject, relays, mint },
    rawRelays,
    redaction: { proofSecretsDropped: true },
  };
  return { ...bundle, digest: captureDigest(bundle) };
}
