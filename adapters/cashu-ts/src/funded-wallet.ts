import {
  MintQuoteState,
  Wallet,
  hashToCurve,
  type MintProofsConfig,
  type MintQuoteBolt11Response,
  type OutputConfig,
  type OutputType,
  type Proof,
  type SendConfig,
} from '@cashu/cashu-ts';
import type { ProofEvidenceView } from '@cashu-fault-lab/adapter-contract';
import {
  computeProofSetHash,
  normalizeMintUrl,
  parseProtocolId,
  type CashuProof,
} from '@cashu-fault-lab/delivery-core';
import { createHash } from 'node:crypto';
import type { CashuTsWalletPort, ReservedCashuTsProofs } from './funded-operations.js';

export interface CashuTsWalletClient {
  loadMint(): Promise<void>;
  createMintQuoteBolt11(amount: number, description?: string): Promise<MintQuoteBolt11Response>;
  checkMintQuoteBolt11(quote: string | MintQuoteBolt11Response): Promise<MintQuoteBolt11Response>;
  mintProofsBolt11(
    amount: number,
    quote: string | MintQuoteBolt11Response,
    config?: MintProofsConfig,
    outputType?: OutputType,
  ): Promise<Proof[]>;
  send(
    amount: number,
    proofs: Proof[],
    config?: SendConfig,
    outputConfig?: OutputConfig,
  ): Promise<{ readonly keep: Proof[]; readonly send: Proof[] }>;
}

export interface FundedCashuTsWalletOptions {
  readonly mintUrl: string;
  readonly unit?: string;
  readonly fundingAmount: number;
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly walletFactory?: (seed: Uint8Array) => CashuTsWalletClient;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface Reservation {
  readonly amount: number;
  readonly unit: string;
  readonly value: ReservedCashuTsProofs;
  readonly inputYs: readonly string[];
  readonly proofSetHash: string;
  state: ProofEvidenceView['state'];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function deliveryProof(proof: Proof): CashuProof {
  return {
    amount: proof.amount.toNumber(),
    id: proof.id,
    secret: proof.secret,
    C: proof.C,
    ...(proof.witness === undefined
      ? {}
      : {
          witness:
            typeof proof.witness === 'string' ? proof.witness : JSON.stringify(proof.witness),
        }),
    ...(proof.dleq === undefined ? {} : { dleq: { ...proof.dleq } }),
    ...(proof.p2pk_e === undefined ? {} : { p2pk_e: proof.p2pk_e }),
  };
}

function proofY(proof: Proof): string {
  return hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
}

function seedBytes(seed: string): Uint8Array {
  if (seed.length === 0) throw new Error('Cashu wallet seed is required');
  return Uint8Array.from(
    createHash('sha512').update('cashu-fault-lab/cashu-ts-wallet-seed-v1\0').update(seed).digest(),
  );
}

export class FundedCashuTsWallet implements CashuTsWalletPort {
  readonly #mintUrl: string;
  readonly #unit: string;
  readonly #fundingAmount: number;
  readonly #pollAttempts: number;
  readonly #pollIntervalMs: number;
  readonly #walletFactory: (seed: Uint8Array) => CashuTsWalletClient;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #reservations = new Map<string, Reservation>();
  #client: CashuTsWalletClient | undefined;
  #available: Proof[] = [];

  constructor(options: FundedCashuTsWalletOptions) {
    this.#mintUrl = normalizeMintUrl(options.mintUrl);
    this.#unit = options.unit ?? 'sat';
    if (this.#unit.length === 0) throw new Error('Cashu wallet unit is required');
    this.#fundingAmount = positiveInteger(options.fundingAmount, 'fundingAmount');
    this.#pollAttempts = positiveInteger(options.pollAttempts ?? 60, 'pollAttempts');
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 100, 'pollIntervalMs');
    this.#walletFactory =
      options.walletFactory ??
      ((seed) => new Wallet(this.#mintUrl, { unit: this.#unit, bip39seed: seed }));
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async reset(seed: string): Promise<void> {
    this.#reservations.clear();
    this.#available = [];
    const client = this.#walletFactory(seedBytes(seed));
    this.#client = client;
    try {
      await client.loadMint();
      let quote = await client.createMintQuoteBolt11(
        this.#fundingAmount,
        'cashu-fault-lab funded adapter',
      );
      for (
        let attempt = 0;
        quote.state !== MintQuoteState.PAID && attempt < this.#pollAttempts;
        attempt += 1
      ) {
        quote = await client.checkMintQuoteBolt11(quote);
        if (quote.state !== MintQuoteState.PAID) {
          await this.#sleep(this.#pollIntervalMs);
        }
      }
      if (quote.state !== MintQuoteState.PAID) {
        throw new Error('Fake mint quote did not become paid');
      }
      // Funding proofs are intentionally random. Replaying a seeded lab run must not recreate
      // blinded mint outputs that an already-used fake mint correctly rejects as duplicates.
      this.#available = await client.mintProofsBolt11(this.#fundingAmount, quote, undefined, {
        type: 'random',
      });
    } catch {
      this.#client = undefined;
      this.#available = [];
      throw new Error('Cashu wallet funding failed');
    }
  }

  async reserve(
    amount: number,
    unit: string,
    mints: readonly string[],
    deliveryId: string,
  ): Promise<ReservedCashuTsProofs> {
    parseProtocolId(deliveryId);
    const existing = this.#reservations.get(deliveryId);
    if (existing !== undefined) {
      if (existing.amount !== amount || existing.unit !== unit) {
        throw new Error('Cashu delivery reservation identity conflicts');
      }
      return existing.value;
    }
    if (unit !== this.#unit || !mints.map(normalizeMintUrl).includes(this.#mintUrl)) {
      throw new Error('Cashu wallet cannot satisfy the requested mint or unit');
    }
    const client = this.#client;
    if (client === undefined) throw new Error('Cashu wallet is not funded');
    let result: { readonly keep: Proof[]; readonly send: Proof[] };
    try {
      // A replayed seeded run must not submit the same blinded swap outputs again.
      result = await client.send(amount, this.#available, undefined, {
        send: { type: 'random' },
        keep: { type: 'random' },
      });
    } catch {
      throw new Error('Cashu wallet proof reservation failed');
    }
    const total = result.send.reduce((sum, proof) => sum + proof.amount.toNumber(), 0);
    if (total !== amount || result.send.length === 0) {
      throw new Error('Cashu wallet returned an invalid proof reservation');
    }
    this.#available = [...result.keep];
    const inputYs = result.send.map(proofY);
    const value: ReservedCashuTsProofs = {
      mint: this.#mintUrl,
      proofs: result.send.map(deliveryProof),
    };
    this.#reservations.set(deliveryId, {
      amount,
      unit,
      value,
      inputYs,
      proofSetHash: computeProofSetHash({
        mint: this.#mintUrl,
        unit,
        ys: inputYs.map((value) => Uint8Array.from(Buffer.from(value, 'hex'))),
      }),
      state: 'pending',
    });
    return value;
  }

  async markSettled(deliveryId: string): Promise<void> {
    const reservation = this.#reservations.get(deliveryId);
    if (reservation === undefined) throw new Error('Cashu delivery reservation was not found');
    reservation.state = 'spent';
  }

  async evidence(deliveryId: string): Promise<ProofEvidenceView> {
    const reservation = this.#reservations.get(deliveryId);
    if (reservation === undefined) throw new Error('Cashu delivery reservation was not found');
    return {
      deliveryId,
      proofSetHash: reservation.proofSetHash,
      inputYs: [...reservation.inputYs],
      state: reservation.state,
    };
  }
}
