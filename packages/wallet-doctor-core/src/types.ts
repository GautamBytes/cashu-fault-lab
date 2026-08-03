/**
 * Pure NIP-60 wallet-state model for the wallet doctor suite.
 *
 * These types describe already-normalized observations. Decryption, signature
 * verification, and transport live in `@cashu-fault-lab/wallet-doctor-contract`;
 * diagnosis and plan safety live in `@cashu-fault-lab/wallet-doctor-oracle`.
 * This package performs no I/O and imports no wallet, relay, or mint code.
 */

export const NIP60_KINDS = {
  wallet: 17375,
  token: 7375,
  history: 7376,
  quote: 7374,
  deletion: 5,
} as const;

/**
 * One proof as observed inside a decrypted token event. The secret is dropped
 * at capture time; `y` is the public NUT-00 hash-to-curve of the secret, which
 * is exactly what a wallet sends to a mint for NUT-07 state checks.
 */
export interface ProofView {
  /** Keyset identifier from the token payload (`id` field of a proof). */
  readonly keysetId: string;
  readonly amount: number;
  /** Compressed secp256k1 point hex: NUT-00 `Y = hash_to_curve(secret)`. */
  readonly y: string;
}

export interface TokenEventView {
  readonly eventId: string;
  readonly createdAt: number;
  readonly mint: string;
  readonly unit: string;
  readonly proofs: readonly ProofView[];
  /** Predecessor token event ids destroyed by this rollover (`del`). */
  readonly del: readonly string[];
  /** Canonical relay urls that served this event (sorted, deduplicated). */
  readonly seenOn: readonly string[];
}

export interface WalletEventView {
  readonly eventId: string;
  readonly createdAt: number;
  readonly mints: readonly string[];
  /** True when the encrypted wallet event carries a P2PK `privkey` tag. */
  readonly hasP2pkKey: boolean;
  /** Canonical relay urls that served this exact event version. */
  readonly seenOn: readonly string[];
}

export interface DeletionView {
  readonly eventId: string;
  readonly createdAt: number;
  /** `e` tag targets of the kind:5 event. */
  readonly targets: readonly string[];
  /** `k` tag kinds of the kind:5 event. */
  readonly kinds: readonly number[];
  readonly seenOn: readonly string[];
}

export interface HistoryEventView {
  readonly eventId: string;
  readonly createdAt: number;
  readonly direction: 'in' | 'out' | null;
  readonly amount: number | null;
  readonly unit: string | null;
  /** Token event ids referenced with the `created` marker. */
  readonly created: readonly string[];
  /** Token event ids referenced with the `destroyed` marker. */
  readonly destroyed: readonly string[];
  /** Token event ids referenced with the `redeemed` marker (NIP-61). */
  readonly redeemed: readonly string[];
  readonly seenOn: readonly string[];
}

export interface QuoteEventView {
  readonly eventId: string;
  readonly createdAt: number;
  /** NIP-40 expiration timestamp, when present. */
  readonly expiration: number | null;
  readonly mint: string | null;
  readonly seenOn: readonly string[];
}

export type MalformedReason =
  'decryption_failed' | 'invalid_payload' | 'invalid_signature' | 'wallet_without_mints';

export interface MalformedEventView {
  /** Null when the event could not be parsed at all. */
  readonly eventId: string | null;
  readonly kind: number | null;
  readonly reason: MalformedReason;
  readonly seenOn: readonly string[];
}

/** Normalized NIP-60 state served by one relay. */
export interface RelayObservation {
  readonly url: string;
  readonly status: 'ok' | 'error';
  readonly error: string | null;
  /** All wallet event versions this relay served (replaceable: usually one). */
  readonly wallet: readonly WalletEventView[];
  readonly tokens: readonly TokenEventView[];
  readonly deletions: readonly DeletionView[];
  readonly history: readonly HistoryEventView[];
  readonly quotes: readonly QuoteEventView[];
  readonly malformed: readonly MalformedEventView[];
}

export type ProofState = 'UNSPENT' | 'SPENT' | 'PENDING';

/** Mint-verified truth for one proof, from NUT-07 checkstate. */
export interface MintObservation {
  readonly mint: string;
  readonly y: string;
  readonly state: ProofState;
}

/** Top-level oracle input: per-relay observations plus mint truth. */
export interface DoctorObservation {
  readonly subject: string;
  readonly relays: readonly RelayObservation[];
  readonly mint: readonly MintObservation[];
}
