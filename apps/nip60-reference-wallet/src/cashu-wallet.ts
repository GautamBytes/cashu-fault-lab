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
    const result = await this.#wallet.send(amount, normalizedProofs(proofs as unknown as Proof[]));
    return {
      send: normalizedProofs(result.send).map(normalizeProof),
      keep: normalizedProofs(result.keep).map(normalizeProof),
    };
  }
}
