import { hashToCurve } from '@cashu/cashu-ts';
import type {
  DeletionView,
  HistoryEventView,
  MalformedReason,
  ProofView,
  QuoteEventView,
  TokenEventView,
  WalletEventView,
} from '@cashu-fault-lab/wallet-doctor-core';
import type { Event } from 'nostr-tools';

/** Result of normalizing one decrypted payload: a view or a malformed reason. */
export type NormalizeResult<T> =
  | { readonly ok: true; readonly view: T }
  | { readonly ok: false; readonly reason: MalformedReason };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value as string[];
}

/** NUT-00 `Y = hash_to_curve(secret)` as compressed-point hex. Public value. */
export function proofY(secret: string): string {
  return hashToCurve(new TextEncoder().encode(secret)).toHex(true);
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function normalizeTokenPayload(
  event: Event,
  payload: unknown,
  seenOn: readonly string[],
): NormalizeResult<TokenEventView> {
  if (!isRecord(payload)) return { ok: false, reason: 'invalid_payload' };
  if (typeof payload.mint !== 'string' || payload.mint.length === 0) {
    return { ok: false, reason: 'invalid_payload' };
  }
  if (!Array.isArray(payload.proofs)) return { ok: false, reason: 'invalid_payload' };
  const proofs: ProofView[] = [];
  for (const candidate of payload.proofs) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.secret !== 'string' ||
      !Number.isSafeInteger(candidate.amount) ||
      (candidate.amount as number) < 1
    ) {
      return { ok: false, reason: 'invalid_payload' };
    }
    proofs.push({
      keysetId: candidate.id,
      amount: candidate.amount as number,
      y: proofY(candidate.secret),
    });
  }
  const unit = payload.unit === undefined ? 'sat' : payload.unit;
  if (typeof unit !== 'string' || unit.length === 0)
    return { ok: false, reason: 'invalid_payload' };
  const del = payload.del === undefined ? [] : stringArray(payload.del);
  if (del === null) return { ok: false, reason: 'invalid_payload' };
  return {
    ok: true,
    view: {
      eventId: event.id,
      createdAt: event.created_at,
      mint: payload.mint,
      unit,
      proofs,
      del,
      seenOn,
    },
  };
}

export function normalizeWalletPayload(
  event: Event,
  payload: unknown,
  seenOn: readonly string[],
): NormalizeResult<WalletEventView> {
  // Wallet content is an array of [key, value] pairs.
  if (!Array.isArray(payload)) return { ok: false, reason: 'invalid_payload' };
  const mints: string[] = [];
  let hasP2pkKey = false;
  for (const pair of payload) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') {
      return { ok: false, reason: 'invalid_payload' };
    }
    if (pair[0] === 'mint' && typeof pair[1] === 'string') mints.push(pair[1]);
    if (pair[0] === 'privkey') hasP2pkKey = true;
  }
  if (mints.length === 0) return { ok: false, reason: 'wallet_without_mints' };
  return {
    ok: true,
    view: {
      eventId: event.id,
      createdAt: event.created_at,
      mints: [...new Set(mints)].sort(),
      hasP2pkKey,
      seenOn,
    },
  };
}

export function normalizeHistoryEvent(
  event: Event,
  payload: unknown,
  seenOn: readonly string[],
): NormalizeResult<HistoryEventView> {
  const created: string[] = [];
  const destroyed: string[] = [];
  const redeemed: string[] = [];
  let direction: 'in' | 'out' | null = null;
  let amount: number | null = null;
  let unit: string | null = null;

  // Encrypted content: array of [key, value] pairs, e tags carry markers.
  if (payload !== undefined) {
    if (!Array.isArray(payload)) return { ok: false, reason: 'invalid_payload' };
    for (const pair of payload) {
      if (!Array.isArray(pair) || pair.length < 2 || typeof pair[0] !== 'string') {
        return { ok: false, reason: 'invalid_payload' };
      }
      if (pair[0] === 'direction' && (pair[1] === 'in' || pair[1] === 'out')) direction = pair[1];
      if (pair[0] === 'amount' && typeof pair[1] === 'string') {
        const parsed = Number.parseInt(pair[1], 10);
        if (Number.isSafeInteger(parsed)) amount = parsed;
      }
      if (pair[0] === 'unit' && typeof pair[1] === 'string') unit = pair[1];
      if (pair[0] === 'e' && typeof pair[1] === 'string') {
        const marker = pair[3];
        if (marker === 'created') created.push(pair[1]);
        else if (marker === 'destroyed') destroyed.push(pair[1]);
        else if (marker === 'redeemed') redeemed.push(pair[1]);
      }
    }
  }

  // Plaintext tags (redeemed markers stay unencrypted per NIP-60).
  for (const tag of event.tags) {
    if (tag[0] !== 'e' || typeof tag[1] !== 'string') continue;
    const marker = tag[3];
    if (marker === 'created' && !created.includes(tag[1])) created.push(tag[1]);
    else if (marker === 'destroyed' && !destroyed.includes(tag[1])) destroyed.push(tag[1]);
    else if (marker === 'redeemed' && !redeemed.includes(tag[1])) redeemed.push(tag[1]);
  }

  return {
    ok: true,
    view: {
      eventId: event.id,
      createdAt: event.created_at,
      direction,
      amount,
      unit,
      created: created.sort(),
      destroyed: destroyed.sort(),
      redeemed: redeemed.sort(),
      seenOn,
    },
  };
}

export function normalizeDeletionEvent(event: Event, seenOn: readonly string[]): DeletionView {
  const targets: string[] = [];
  const kinds: number[] = [];
  for (const tag of event.tags) {
    if (tag[0] === 'e' && typeof tag[1] === 'string') targets.push(tag[1]);
    if (tag[0] === 'k' && typeof tag[1] === 'string') {
      const parsed = Number.parseInt(tag[1], 10);
      if (Number.isSafeInteger(parsed)) kinds.push(parsed);
    }
  }
  return {
    eventId: event.id,
    createdAt: event.created_at,
    targets: [...new Set(targets)].sort(),
    kinds: [...new Set(kinds)].sort((a, b) => a - b),
    seenOn,
  };
}

export function normalizeQuoteEvent(
  event: Event,
  seenOn: readonly string[],
): NormalizeResult<QuoteEventView> {
  let expiration: number | null = null;
  let mint: string | null = null;
  for (const tag of event.tags) {
    if (tag[0] === 'expiration' && typeof tag[1] === 'string') {
      const parsed = Number.parseInt(tag[1], 10);
      if (Number.isSafeInteger(parsed)) expiration = parsed;
    }
    if (tag[0] === 'mint' && typeof tag[1] === 'string') mint = tag[1];
  }
  return {
    ok: true,
    view: { eventId: event.id, createdAt: event.created_at, expiration, mint, seenOn },
  };
}
