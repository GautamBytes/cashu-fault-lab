import {
  Amount,
  normalizeProofAmounts,
  sumProofs,
  type Proof,
  type ProofLike,
  type SendResponse,
} from '@cashu/cashu-ts';
import { normalizeMintUrl, parseProtocolId, type CashuProof } from '@cashu-fault-lab/delivery-core';
import { createHash } from 'node:crypto';
import type { ReservedProofSet, ReservePayment, SenderWallet } from '../ports/wallet.js';

export type SenderReservationStatus = 'held' | 'recovery_required' | 'settled' | 'released';

export interface CashuTsOfflineSendBuilder {
  includeFees(on?: boolean): this;
  offlineExactOnly(requireDleq?: boolean): this;
  privkey(key: string | string[]): this;
  run(): Promise<SendResponse>;
}

export interface CashuTsOfflineWallet {
  readonly ops: {
    send(amount: number, proofs: Proof[]): CashuTsOfflineSendBuilder;
  };
  getFeesForProofs(proofs: Array<Pick<Proof, 'id'>>): Amount;
}

export interface CashuTsWalletAccount {
  readonly mint: string;
  readonly unit: string;
  readonly wallet: CashuTsOfflineWallet;
  readonly proofs: readonly ProofLike[];
  readonly privateKeys?: string | readonly string[];
  readonly requireDleq?: boolean;
}

type ReservationSelector = (accounts: readonly CashuTsWalletAccount[]) => Promise<ReservedProofSet>;

export interface SenderReservationStore {
  reserveExact(input: ReservePayment, selector: ReservationSelector): Promise<ReservedProofSet>;
  transition(deliveryId: string, status: SenderReservationStatus): Promise<void>;
}

interface ReservationBinding {
  readonly deliveryId: string;
  readonly amount: number;
  readonly unit: string;
  readonly mints: readonly string[];
}

interface ReservationRecord {
  readonly binding: ReservationBinding;
  readonly value: ReservedProofSet;
  readonly status: SenderReservationStatus;
}

function cloneProof(proof: ProofLike): Proof {
  const normalized = normalizeProofAmounts([proof])[0];
  if (!normalized) throw new Error('Cashu proof is missing');
  return {
    id: normalized.id,
    amount: Amount.from(normalized.amount),
    secret: normalized.secret,
    C: normalized.C,
    ...(normalized.dleq ? { dleq: { ...normalized.dleq } } : {}),
    ...(normalized.p2pk_e ? { p2pk_e: normalized.p2pk_e } : {}),
    ...(normalized.witness === undefined ? {} : { witness: structuredClone(normalized.witness) }),
  };
}

function cloneReserved(value: ReservedProofSet): ReservedProofSet {
  return structuredClone(value);
}

function normalizeBinding(input: ReservePayment): ReservationBinding {
  parseProtocolId(input.deliveryId);
  if (!Number.isSafeInteger(input.amount) || input.amount < 1) {
    throw new Error('Reservation amount must be a positive safe integer');
  }
  if (typeof input.unit !== 'string' || input.unit.length === 0) {
    throw new Error('Reservation unit is required');
  }
  if (input.mints.length === 0) throw new Error('Reservation needs at least one mint');
  const mints = [...new Set(input.mints.map(normalizeMintUrl))];
  return {
    deliveryId: input.deliveryId,
    amount: input.amount,
    unit: input.unit,
    mints,
  };
}

function sameBinding(left: ReservationBinding, right: ReservationBinding): boolean {
  return (
    left.deliveryId === right.deliveryId &&
    left.amount === right.amount &&
    left.unit === right.unit &&
    left.mints.length === right.mints.length &&
    left.mints.every((mint, index) => mint === right.mints[index])
  );
}

function proofIdentity(mint: string, unit: string, proof: Pick<ProofLike, 'id' | 'secret' | 'C'>) {
  return createHash('sha256')
    .update('cashu-fault-lab/sender-proof-v1\0')
    .update(normalizeMintUrl(mint))
    .update('\0')
    .update(unit)
    .update('\0')
    .update(proof.id)
    .update('\0')
    .update(proof.secret)
    .update('\0')
    .update(proof.C)
    .digest('hex');
}

function assertSelection(
  binding: ReservationBinding,
  accounts: readonly CashuTsWalletAccount[],
  selected: ReservedProofSet,
): void {
  if (
    selected.netAmount !== binding.amount ||
    selected.unit !== binding.unit ||
    !binding.mints.includes(normalizeMintUrl(selected.mint)) ||
    selected.proofs.length === 0 ||
    selected.proofs.length > 256
  ) {
    throw new Error('Proof selector returned a reservation outside the requested binding');
  }
  const account = accounts.find(
    (candidate) =>
      normalizeMintUrl(candidate.mint) === normalizeMintUrl(selected.mint) &&
      candidate.unit === selected.unit,
  );
  if (!account) throw new Error('Proof selector returned an unavailable mint account');
  const available = new Set(
    account.proofs.map((proof) => proofIdentity(account.mint, account.unit, proof)),
  );
  const identities = selected.proofs.map((proof) =>
    proofIdentity(selected.mint, selected.unit, proof),
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error('Proof selector returned duplicate proofs');
  }
  if (identities.some((identity) => !available.has(identity))) {
    throw new Error('Proof selector returned a proof outside the available inventory');
  }
}

export class InMemorySenderReservationStore implements SenderReservationStore {
  readonly #accounts: readonly CashuTsWalletAccount[];
  readonly #reservations = new Map<string, ReservationRecord>();
  #tail: Promise<void> = Promise.resolve();

  constructor(accounts: readonly CashuTsWalletAccount[]) {
    this.#accounts = accounts.map((account) => ({
      ...account,
      mint: normalizeMintUrl(account.mint),
      proofs: account.proofs.map(cloneProof),
      ...(account.privateKeys
        ? {
            privateKeys: Array.isArray(account.privateKeys)
              ? [...account.privateKeys]
              : account.privateKeys,
          }
        : {}),
    }));
  }

  async reserveExact(
    input: ReservePayment,
    selector: ReservationSelector,
  ): Promise<ReservedProofSet> {
    const binding = normalizeBinding(input);
    return this.#transaction(async () => {
      const previous = this.#reservations.get(binding.deliveryId);
      if (previous) {
        if (!sameBinding(previous.binding, binding)) {
          throw new Error('Delivery ID is already bound to different reservation parameters');
        }
        if (previous.status === 'released') {
          throw new Error('Delivery reservation was already released after rejection');
        }
        return cloneReserved(previous.value);
      }

      const unavailable = new Set<string>();
      for (const reservation of this.#reservations.values()) {
        if (reservation.status === 'released') continue;
        for (const proof of reservation.value.proofs) {
          unavailable.add(proofIdentity(reservation.value.mint, reservation.value.unit, proof));
        }
      }
      const accounts = binding.mints.flatMap((mint) =>
        this.#accounts
          .filter((account) => account.mint === mint && account.unit === binding.unit)
          .map((account) => ({
            ...account,
            proofs: account.proofs
              .filter((proof) => !unavailable.has(proofIdentity(account.mint, account.unit, proof)))
              .map(cloneProof),
          })),
      );
      const selected = await selector(accounts);
      assertSelection(binding, accounts, selected);
      const value = cloneReserved({ ...selected, mint: normalizeMintUrl(selected.mint) });
      this.#reservations.set(binding.deliveryId, { binding, value, status: 'held' });
      return cloneReserved(value);
    });
  }

  async transition(deliveryId: string, status: SenderReservationStatus): Promise<void> {
    parseProtocolId(deliveryId);
    await this.#transaction(() => {
      const previous = this.#reservations.get(deliveryId);
      if (!previous) throw new Error('Sender reservation does not exist');
      if (previous.status === status) return;
      if (previous.status === 'settled') {
        throw new Error('Settled sender reservation cannot change state');
      }
      if (previous.status === 'released') {
        throw new Error('Released sender reservation cannot change state');
      }
      if (status === 'held') throw new Error('Sender reservation cannot return to held state');
      this.#reservations.set(deliveryId, { ...previous, status });
    });
  }

  async status(deliveryId: string): Promise<SenderReservationStatus | undefined> {
    await this.#tail;
    return this.#reservations.get(deliveryId)?.status;
  }

  async #transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function toDeliveryProof(proof: Proof): CashuProof {
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
    ...(proof.dleq ? { dleq: { ...proof.dleq } } : {}),
    ...(proof.p2pk_e ? { p2pk_e: proof.p2pk_e } : {}),
  };
}

export interface CashuTsSenderWalletOptions {
  readonly store: SenderReservationStore;
}

export class CashuTsSenderWallet implements SenderWallet {
  readonly #store: SenderReservationStore;

  constructor(options: CashuTsSenderWalletOptions) {
    this.#store = options.store;
  }

  async reserveExact(input: ReservePayment): Promise<ReservedProofSet> {
    return this.#store.reserveExact(input, async (accounts) => {
      const failures: unknown[] = [];
      for (const account of accounts) {
        try {
          let builder = account.wallet.ops
            .send(input.amount, account.proofs.map(cloneProof))
            .includeFees(true)
            .offlineExactOnly(account.requireDleq ?? false);
          if (account.privateKeys) {
            builder = builder.privkey(
              typeof account.privateKeys === 'string'
                ? account.privateKeys
                : [...account.privateKeys],
            );
          }
          const response = await builder.run();
          if (response.send.length === 0) continue;
          const faceAmount = sumProofs(response.send).toNumber();
          const fee = account.wallet.getFeesForProofs(response.send).toNumber();
          const netAmount = faceAmount - fee;
          if (netAmount !== input.amount) {
            throw new Error('cashu-ts returned a proof set with a non-exact net amount');
          }
          return {
            mint: normalizeMintUrl(account.mint),
            unit: account.unit,
            netAmount,
            proofs: response.send.map(toDeliveryProof),
          };
        } catch (error) {
          failures.push(error);
        }
      }
      throw new AggregateError(
        failures,
        'No exact fee-correct offline Cashu proof set is available',
      );
    });
  }

  async markSettled(deliveryId: string): Promise<void> {
    await this.#store.transition(deliveryId, 'settled');
  }

  async releaseRejected(deliveryId: string): Promise<void> {
    await this.#store.transition(deliveryId, 'released');
  }

  async markRecoveryRequired(deliveryId: string): Promise<void> {
    await this.#store.transition(deliveryId, 'recovery_required');
  }
}
