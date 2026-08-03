import { createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip44, type Event } from 'nostr-tools';

/** Minimal proof shape the fixture publishes inside kind:7375 payloads. */
export interface FixtureProof {
  readonly id: string;
  readonly amount: number;
  readonly secret: string;
  readonly C: string;
}

/** Mint-side operations the fixture needs; implemented by cashu-ts in production. */
export interface FixtureMintWallet {
  mintProofs(amount: number): Promise<readonly FixtureProof[]>;
  send(
    amount: number,
    proofs: readonly FixtureProof[],
  ): Promise<{ send: readonly FixtureProof[]; keep: readonly FixtureProof[] }>;
}

export type PublishFn = (relayUrl: string, event: Event) => Promise<void>;

/**
 * Publish fault modes that reproduce the ways real NIP-60 wallets diverge:
 * - `clean`: rollover and deletion reach every relay.
 * - `partial-delete`: rollover everywhere, deletion only to the first relay
 *   (stale token stays live elsewhere -> del-chain break).
 * - `partial-publish`: rollover and deletion only to the first relay
 *   (other relays never see the successor -> partition plus stale view).
 * - `ghost`: the mint swap happens but nothing is published
 *   (live events carry spent proofs -> ghost balance).
 * - `delete-only`: a deletion is published with no spend and no successor
 *   (unspent proofs lose their event -> orphaned proofs).
 */
export type SpendMode = 'clean' | 'partial-delete' | 'partial-publish' | 'ghost' | 'delete-only';

export const SPEND_MODES: readonly SpendMode[] = [
  'clean',
  'partial-delete',
  'partial-publish',
  'ghost',
  'delete-only',
];

export interface DoctorWalletOptions {
  /** Mint URL the fixture itself talks to (may be a private network alias). */
  readonly mint: string;
  /**
   * Mint URL published into NIP-60 payloads when it differs from `mint`
   * (e.g. a host-reachable alias); readers of the events must be able to
   * reach this URL. Defaults to `mint`.
   */
  readonly publicMint?: string;
  readonly relays: readonly string[];
  readonly secretKey: Uint8Array;
  readonly wallet: FixtureMintWallet;
  readonly publish: PublishFn;
  /** Injectable clock (unix seconds) for deterministic tests. */
  readonly now?: () => number;
}

const KEY_DERIVATION_DOMAIN = 'cashu-fault-lab/nip60-fixture-key-v1';

/** Deterministic fixture key from a scenario seed (lab use only). */
export function deriveFixtureKey(seed: string): Uint8Array {
  if (seed.length < 1 || seed.length > 256) {
    throw new Error('Fixture seed must be between 1 and 256 characters');
  }
  return createHash('sha256').update(`${KEY_DERIVATION_DOMAIN}\0${seed}`, 'utf8').digest();
}

export class DoctorWallet {
  readonly #options: DoctorWalletOptions;
  #proofs: FixtureProof[] = [];
  #currentTokenEventId: string | null = null;
  #published: string[] = [];
  #lastCreatedAt = 0;

  constructor(options: DoctorWalletOptions) {
    if (options.relays.length === 0) throw new Error('At least one relay is required');
    this.#options = options;
  }

  get pubkey(): string {
    return getPublicKey(this.#options.secretKey);
  }

  /** Lab-only: the harness needs the generated test key to run captures. */
  get secretKeyHex(): string {
    return Buffer.from(this.#options.secretKey).toString('hex');
  }

  get mint(): string {
    return this.#options.mint;
  }

  /** Mint URL published in events; the one readers (and the doctor) can reach. */
  get publicMint(): string {
    return this.#options.publicMint ?? this.#options.mint;
  }

  get relays(): readonly string[] {
    return this.#options.relays;
  }

  get balance(): number {
    return this.#proofs.reduce((total, proof) => total + proof.amount, 0);
  }

  get proofCount(): number {
    return this.#proofs.length;
  }

  get currentTokenEventId(): string | null {
    return this.#currentTokenEventId;
  }

  get publishedEvents(): readonly string[] {
    return this.#published;
  }

  #now(): number {
    const value = this.#options.now?.() ?? Math.floor(Date.now() / 1000);
    this.#lastCreatedAt = Math.max(this.#lastCreatedAt + 1, value);
    return this.#lastCreatedAt;
  }

  #conversationKey(): Uint8Array {
    return nip44.v2.utils.getConversationKey(this.#options.secretKey, this.pubkey);
  }

  #encrypt(payload: unknown): string {
    return nip44.v2.encrypt(JSON.stringify(payload), this.#conversationKey());
  }

  async #publishTo(relays: readonly string[], event: Event): Promise<void> {
    for (const relay of relays) {
      await this.#options.publish(relay, event);
    }
    this.#published.push(event.id);
  }

  /** Publish the kind:17375 wallet event to every configured relay. */
  async publishWalletEvent(): Promise<string> {
    const event = finalizeEvent(
      {
        kind: 17375,
        created_at: this.#now(),
        tags: [],
        content: this.#encrypt([['mint', this.publicMint]]),
      },
      this.#options.secretKey,
    );
    await this.#publishTo(this.#options.relays, event);
    return event.id;
  }

  /** Mint fresh proofs and record them in a new kind:7375 on every relay. */
  async mintTokens(amount: number): Promise<{ tokenEventId: string; balance: number }> {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('Mint amount must be a positive integer');
    }
    const proofs = await this.#options.wallet.mintProofs(amount);
    this.#proofs = [...this.#proofs, ...proofs];
    const event = this.#buildTokenEvent(proofs, []);
    await this.#publishTo(this.#options.relays, event);
    this.#currentTokenEventId = event.id;
    return { tokenEventId: event.id, balance: this.balance };
  }

  #buildTokenEvent(proofs: readonly FixtureProof[], del: readonly string[]): Event {
    return finalizeEvent(
      {
        kind: 7375,
        created_at: this.#now(),
        tags: [],
        content: this.#encrypt({
          mint: this.publicMint,
          proofs: proofs.map((proof) => ({
            id: proof.id,
            amount: proof.amount,
            secret: proof.secret,
            C: proof.C,
          })),
          del,
        }),
      },
      this.#options.secretKey,
    );
  }

  #buildDeletionEvent(target: string): Event {
    return finalizeEvent(
      {
        kind: 5,
        created_at: this.#now(),
        tags: [
          ['e', target],
          ['k', '7375'],
        ],
        content: '',
      },
      this.#options.secretKey,
    );
  }

  async spend(
    amount: number,
    mode: SpendMode,
  ): Promise<{ tokenEventId: string | null; deletionEventId: string | null; balance: number }> {
    if (!SPEND_MODES.includes(mode)) throw new Error(`Spend mode is invalid: ${mode}`);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('Spend amount must be a positive integer');
    }
    if (mode === 'delete-only') {
      if (this.#currentTokenEventId === null) throw new Error('No live token event to delete');
      const deletion = this.#buildDeletionEvent(this.#currentTokenEventId);
      await this.#publishTo(this.#options.relays, deletion);
      const deletedEventId = this.#currentTokenEventId;
      this.#currentTokenEventId = null;
      // Proofs stay in local state: they are still valid at the mint, which is
      // exactly the orphaned-proofs situation the doctor must flag.
      return { tokenEventId: null, deletionEventId: deletion.id, balance: this.balance };
    }
    if (this.#currentTokenEventId === null) throw new Error('No live token event to spend from');
    if (amount > this.balance) {
      throw new Error(`Spend amount ${amount} exceeds fixture balance ${this.balance}`);
    }
    const previousTokenEventId = this.#currentTokenEventId;
    // The mint wallet clamps for input fees when needed (see CashuTsMintWallet).
    const { keep } = await this.#options.wallet.send(amount, this.#proofs);
    if (mode === 'ghost') {
      // Drop every output: nothing new is published, so relays keep serving the
      // old token whose proofs the mint now reports SPENT.
      this.#proofs = [];
      return {
        tokenEventId: previousTokenEventId,
        deletionEventId: null,
        balance: 0,
      };
    }
    const rollover = this.#buildTokenEvent(keep, [previousTokenEventId]);
    const deletion = this.#buildDeletionEvent(previousTokenEventId);
    const rolloverRelays =
      mode === 'partial-publish' ? this.#options.relays.slice(0, 1) : this.#options.relays;
    const deletionRelays =
      mode === 'clean' ? this.#options.relays : this.#options.relays.slice(0, 1);
    await this.#publishTo(rolloverRelays, rollover);
    await this.#publishTo(deletionRelays, deletion);
    this.#proofs = [...keep];
    this.#currentTokenEventId = rollover.id;
    return { tokenEventId: rollover.id, deletionEventId: deletion.id, balance: this.balance };
  }
}
