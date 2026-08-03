import { Mint, normalizeProofAmounts, Wallet, type Proof } from '@cashu/cashu-ts';
import type { FixtureMintWallet, FixtureProof } from './wallet.js';

function normalizeProof(proof: Proof): FixtureProof {
  const point = proof.C as unknown as string | { toHex(compressed: boolean): string };
  return {
    id: proof.id,
    amount: Number(proof.amount),
    secret: proof.secret,
    C: typeof point === 'string' ? point : point.toHex(true),
  };
}

function normalizedProofs(proofs: readonly Proof[]): Proof[] {
  return normalizeProofAmounts([...proofs]);
}

const QUOTE_POLL_ATTEMPTS = 40;
const QUOTE_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** cashu-ts-backed mint wallet for funded lanes (real mint, real proofs). */
export class CashuTsMintWallet implements FixtureMintWallet {
  readonly #wallet: Wallet;
  #loaded = false;

  constructor(mint: string) {
    this.#wallet = new Wallet(new Mint(mint));
  }

  async mintProofs(amount: number): Promise<readonly FixtureProof[]> {
    if (!this.#loaded) {
      await this.#wallet.loadMint();
      this.#loaded = true;
    }
    let quote = await this.#wallet.createMintQuoteBolt11(amount, 'nip60 reference wallet');
    for (let attempt = 0; quote.state !== 'PAID' && attempt < QUOTE_POLL_ATTEMPTS; attempt += 1) {
      await sleep(QUOTE_POLL_INTERVAL_MS);
      quote = await this.#wallet.checkMintQuoteBolt11(quote);
    }
    if (quote.state !== 'PAID') {
      throw new Error(`mint quote did not become paid (state ${quote.state})`);
    }
    const preview = await this.#wallet.prepareMint('bolt11', amount, quote);
    const proofs = await this.#wallet.completeMint(preview);
    return normalizedProofs(proofs).map(normalizeProof);
  }

  async send(
    amount: number,
    proofs: readonly FixtureProof[],
  ): Promise<{ send: readonly FixtureProof[]; keep: readonly FixtureProof[] }> {
    if (!this.#loaded) {
      await this.#wallet.loadMint();
      this.#loaded = true;
    }
    // Always take the online swap path via prepareSwapToSend/completeSwap.
    // wallet.send() may satisfy an exact offline match without contacting the
    // mint, which breaks ghost-balance (live event proofs would stay UNSPENT).
    // includeFees is false so `amount` is the exact send split; input fees
    // reduce keep. Clamp to maxSpendableAfterFees so full-balance/ghost spends
    // still succeed when Nutshell charges per-input fees (1-sat headroom is not
    // enough once several denomination proofs are selected).
    const normalized = normalizedProofs(proofs as unknown as Proof[]);
    const maxSpendable = this.#wallet.maxSpendableAfterFees(normalized).toNumber();
    if (!Number.isSafeInteger(maxSpendable) || maxSpendable < 1) {
      throw new Error('Not enough funds available to send after fees');
    }
    let attempt = Math.min(amount, maxSpendable);
    let lastError: unknown;
    while (attempt >= 1) {
      try {
        const preview = await this.#wallet.prepareSwapToSend(attempt, normalized, {
          includeFees: false,
        });
        const result = await this.#wallet.completeSwap(preview);
        return {
          send: normalizedProofs(result.send).map(normalizeProof),
          keep: normalizedProofs(result.keep).map(normalizeProof),
        };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 1 || !/not enough funds/iu.test(message)) throw error;
        attempt -= 1;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Not enough funds available to send after fees');
  }
}
