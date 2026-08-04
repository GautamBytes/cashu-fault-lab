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

const MAXIMUM_MINT_URL_LENGTH = 2048;
const MAXIMUM_PROOFS_PER_EVENT = 10_000;
const MAXIMUM_SECRET_LENGTH = 8192;
const MAXIMUM_KEYSET_ID_LENGTH = 64;
const MAXIMUM_DELETION_REFERENCES = 10_000;
const MAXIMUM_WALLET_MINTS = 1024;
const MAXIMUM_WALLET_FIELDS = 2048;
const MAXIMUM_HISTORY_REFERENCES = 10_000;
const MAXIMUM_UNIT_LENGTH = 16;
const MAXIMUM_TAGS = 10_000;
const HEX64 = /^[0-9a-f]{64}$/u;

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

function validEventMetadata(event: Event): boolean {
  return HEX64.test(event.id) && Number.isSafeInteger(event.created_at) && event.created_at >= 0;
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
  if (!validEventMetadata(event) || !isRecord(payload)) {
    return { ok: false, reason: 'invalid_payload' };
  }
  if (
    typeof payload.mint !== 'string' ||
    payload.mint.length === 0 ||
    payload.mint.length > MAXIMUM_MINT_URL_LENGTH
  ) {
    return { ok: false, reason: 'invalid_payload' };
  }
  if (!Array.isArray(payload.proofs) || payload.proofs.length > MAXIMUM_PROOFS_PER_EVENT) {
    return { ok: false, reason: 'invalid_payload' };
  }
  const proofs: ProofView[] = [];
  for (const candidate of payload.proofs) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0 ||
      candidate.id.length > MAXIMUM_KEYSET_ID_LENGTH ||
      typeof candidate.secret !== 'string' ||
      candidate.secret.length === 0 ||
      candidate.secret.length > MAXIMUM_SECRET_LENGTH ||
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
  if (typeof unit !== 'string' || unit.length === 0 || unit.length > MAXIMUM_UNIT_LENGTH)
    return { ok: false, reason: 'invalid_payload' };
  const del = payload.del === undefined ? [] : stringArray(payload.del);
  if (
    del === null ||
    del.length > MAXIMUM_DELETION_REFERENCES ||
    del.some((eventId) => !HEX64.test(eventId))
  ) {
    return { ok: false, reason: 'invalid_payload' };
  }
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
  if (
    !validEventMetadata(event) ||
    !Array.isArray(payload) ||
    payload.length > MAXIMUM_WALLET_FIELDS
  ) {
    return { ok: false, reason: 'invalid_payload' };
  }
  const mints: string[] = [];
  let hasP2pkKey = false;
  for (const pair of payload) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') {
      return { ok: false, reason: 'invalid_payload' };
    }
    if (pair[0] === 'mint') {
      if (
        typeof pair[1] !== 'string' ||
        pair[1].length === 0 ||
        pair[1].length > MAXIMUM_MINT_URL_LENGTH
      ) {
        return { ok: false, reason: 'invalid_payload' };
      }
      mints.push(pair[1]);
    }
    if (pair[0] === 'privkey') hasP2pkKey = true;
  }
  const uniqueMints = [...new Set(mints)].sort();
  if (uniqueMints.length === 0) return { ok: false, reason: 'wallet_without_mints' };
  if (uniqueMints.length > MAXIMUM_WALLET_MINTS) {
    return { ok: false, reason: 'invalid_payload' };
  }
  return {
    ok: true,
    view: {
      eventId: event.id,
      createdAt: event.created_at,
      mints: uniqueMints,
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
  if (!validEventMetadata(event) || event.tags.length > MAXIMUM_TAGS) {
    return { ok: false, reason: 'invalid_payload' };
  }
  const created: string[] = [];
  const destroyed: string[] = [];
  const redeemed: string[] = [];
  let direction: 'in' | 'out' | null = null;
  let amount: number | null = null;
  let unit: string | null = null;

  // Encrypted content: array of [key, value] pairs, e tags carry markers.
  if (payload !== undefined) {
    if (!Array.isArray(payload) || payload.length > MAXIMUM_HISTORY_REFERENCES) {
      return { ok: false, reason: 'invalid_payload' };
    }
    for (const pair of payload) {
      if (!Array.isArray(pair) || pair.length < 2 || typeof pair[0] !== 'string') {
        return { ok: false, reason: 'invalid_payload' };
      }
      if (pair[0] === 'direction' && (pair[1] === 'in' || pair[1] === 'out')) direction = pair[1];
      if (pair[0] === 'amount') {
        if (typeof pair[1] !== 'string' || !/^\d+$/u.test(pair[1])) {
          return { ok: false, reason: 'invalid_payload' };
        }
        const parsed = Number.parseInt(pair[1], 10);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          return { ok: false, reason: 'invalid_payload' };
        }
        amount = parsed;
      }
      if (pair[0] === 'unit') {
        if (typeof pair[1] !== 'string' || pair[1].length > MAXIMUM_UNIT_LENGTH) {
          return { ok: false, reason: 'invalid_payload' };
        }
        unit = pair[1];
      }
      if (pair[0] === 'e') {
        if (typeof pair[1] !== 'string' || !HEX64.test(pair[1])) {
          return { ok: false, reason: 'invalid_payload' };
        }
        const marker = pair[3];
        if (marker === 'created') created.push(pair[1]);
        else if (marker === 'destroyed') destroyed.push(pair[1]);
        else if (marker === 'redeemed') redeemed.push(pair[1]);
      }
    }
  }

  // Plaintext tags (redeemed markers stay unencrypted per NIP-60).
  for (const tag of event.tags) {
    if (tag[0] !== 'e' || typeof tag[1] !== 'string' || !HEX64.test(tag[1])) continue;
    const marker = tag[3];
    if (marker === 'created' && !created.includes(tag[1])) created.push(tag[1]);
    else if (marker === 'destroyed' && !destroyed.includes(tag[1])) destroyed.push(tag[1]);
    else if (marker === 'redeemed' && !redeemed.includes(tag[1])) redeemed.push(tag[1]);
  }

  if (
    created.length > MAXIMUM_HISTORY_REFERENCES ||
    destroyed.length > MAXIMUM_HISTORY_REFERENCES ||
    redeemed.length > MAXIMUM_HISTORY_REFERENCES
  ) {
    return { ok: false, reason: 'invalid_payload' };
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

export function normalizeDeletionEvent(
  event: Event,
  seenOn: readonly string[],
): NormalizeResult<DeletionView> {
  if (!validEventMetadata(event) || event.tags.length > MAXIMUM_TAGS) {
    return { ok: false, reason: 'invalid_payload' };
  }
  const targets: string[] = [];
  const kinds: number[] = [];
  for (const tag of event.tags) {
    if (tag[0] === 'e') {
      if (typeof tag[1] !== 'string' || !HEX64.test(tag[1])) {
        return { ok: false, reason: 'invalid_payload' };
      }
      targets.push(tag[1]);
    }
    if (tag[0] === 'k' && typeof tag[1] === 'string') {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(tag[1])) continue;
      const parsed = Number(tag[1]);
      if (Number.isSafeInteger(parsed) && parsed >= 0) kinds.push(parsed);
    }
  }
  if (!kinds.includes(7375)) return { ok: false, reason: 'invalid_payload' };
  if (targets.length > MAXIMUM_DELETION_REFERENCES || kinds.length > MAXIMUM_WALLET_MINTS) {
    return { ok: false, reason: 'invalid_payload' };
  }
  return {
    ok: true,
    view: {
      eventId: event.id,
      createdAt: event.created_at,
      targets: [...new Set(targets)].sort(),
      kinds: [...new Set(kinds)].sort((a, b) => a - b),
      seenOn,
    },
  };
}

export function normalizeQuoteEvent(
  event: Event,
  seenOn: readonly string[],
): NormalizeResult<QuoteEventView> {
  if (!validEventMetadata(event) || event.tags.length > MAXIMUM_TAGS) {
    return { ok: false, reason: 'invalid_payload' };
  }
  let expiration: number | null = null;
  let mint: string | null = null;
  for (const tag of event.tags) {
    if (tag[0] === 'expiration') {
      if (typeof tag[1] !== 'string' || !/^\d+$/u.test(tag[1])) {
        return { ok: false, reason: 'invalid_payload' };
      }
      const parsed = Number.parseInt(tag[1], 10);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return { ok: false, reason: 'invalid_payload' };
      }
      expiration = parsed;
    }
    if (tag[0] === 'mint') {
      if (typeof tag[1] !== 'string' || tag[1].length > MAXIMUM_MINT_URL_LENGTH) {
        return { ok: false, reason: 'invalid_payload' };
      }
      mint = tag[1];
    }
  }
  return {
    ok: true,
    view: { eventId: event.id, createdAt: event.created_at, expiration, mint, seenOn },
  };
}
