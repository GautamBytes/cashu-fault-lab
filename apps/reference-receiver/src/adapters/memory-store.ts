import {
  assertReceiptTransition,
  normalizeMintUrl,
  parseProtocolId,
  type DeliveryReceipt,
  type ProtocolId,
} from '@cashu-fault-lab/delivery-core';
import {
  ReceiverDomainError,
  type CommitSettlement,
  type CreatePaymentRequest,
  type DeliveryRecord,
  type MerchantCredit,
  type PaymentRequestRecord,
  type PrepareDelivery,
  type PrepareResult,
} from '../domain/types.js';
import type { ExactSwapPlanView, ReceiverStore } from '../ports/receiver-store.js';
import { isSameDeliveryBinding, validateRequestBinding } from '../domain/request-binding.js';

interface StoreState {
  readonly requests: Map<string, PaymentRequestRecord>;
  readonly deliveries: Map<string, DeliveryRecord>;
  readonly proofClaims: Map<string, string>;
  readonly requestReservations: Map<string, string>;
  readonly credits: Map<string, MerchantCredit>;
}

function emptyState(): StoreState {
  return {
    requests: new Map(),
    deliveries: new Map(),
    proofClaims: new Map(),
    requestReservations: new Map(),
    credits: new Map(),
  };
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReceiverDomainError('INVALID_REQUEST', `${name} must be a nonnegative safe integer`);
  }
}

function nextReceipt(
  previous: DeliveryReceipt,
  status: DeliveryReceipt['status'],
  detailCode: string,
): DeliveryReceipt {
  const next: DeliveryReceipt = {
    ...previous,
    status,
    detailCode,
    statusVersion: previous.statusVersion + 1,
  };
  assertReceiptTransition(previous, next);
  return next;
}

function sameRequest(left: PaymentRequestRecord, right: PaymentRequestRecord): boolean {
  return (
    left.id === right.id &&
    left.amount === right.amount &&
    left.unit === right.unit &&
    left.singleUse === right.singleUse &&
    left.expiresAt === right.expiresAt &&
    left.mints.length === right.mints.length &&
    left.mints.every((mint, index) => mint === right.mints[index])
  );
}

function sameDelivery(left: DeliveryRecord, input: PrepareDelivery): boolean {
  return (
    left.requestId === input.command.payload.id &&
    left.deliveryId === input.command.payload.delivery.id &&
    left.payloadHash === input.command.payloadHash &&
    left.proofSetHash === input.proofSetHash &&
    left.plan.mint === input.plan.mint &&
    left.plan.unit === input.plan.unit &&
    left.amount === input.netAmount
  );
}

export class MemoryReceiverStore implements ReceiverStore {
  #state = emptyState();
  #tail: Promise<void> = Promise.resolve();
  readonly #redemptionLocks = new Set<string>();

  async reset(): Promise<void> {
    await this.#transaction((draft) => {
      draft.requests.clear();
      draft.deliveries.clear();
      draft.proofClaims.clear();
      draft.requestReservations.clear();
      draft.credits.clear();
    });
    this.#redemptionLocks.clear();
  }

  async createRequest(input: CreatePaymentRequest): Promise<PaymentRequestRecord> {
    const id = parseProtocolId(input.id);
    assertSafeInteger(input.amount, 'Request amount');
    assertSafeInteger(input.expiresAt, 'Request expiry');
    if (typeof input.unit !== 'string' || input.unit.length === 0 || input.mints.length === 0) {
      throw new ReceiverDomainError('INVALID_REQUEST', 'Request unit and mint set are required');
    }
    const mints = [...new Set(input.mints.map(normalizeMintUrl))].sort();
    const record: PaymentRequestRecord = {
      id,
      amount: input.amount,
      unit: input.unit,
      mints,
      singleUse: input.singleUse,
      expiresAt: input.expiresAt,
    };
    return this.#transaction((draft) => {
      const previous = draft.requests.get(id);
      if (previous && !sameRequest(previous, record)) {
        throw new ReceiverDomainError('INVALID_REQUEST', 'Request ID is already bound');
      }
      draft.requests.set(id, previous ?? record);
      return structuredClone(previous ?? record);
    });
  }

  async preflight(
    command: PrepareDelivery['command'],
    now: number,
  ): Promise<DeliveryRecord | undefined> {
    return this.#transaction((draft) => {
      const previous = draft.deliveries.get(command.payload.delivery.id);
      if (previous) {
        if (!isSameDeliveryBinding(previous, command)) {
          throw new ReceiverDomainError('DELIVERY_CONFLICT', 'Delivery ID is already bound');
        }
        return structuredClone(previous);
      }
      const request = draft.requests.get(command.payload.id);
      if (!request) throw new ReceiverDomainError('REQUEST_NOT_FOUND', 'Payment request not found');
      validateRequestBinding(request, command, now);
      const reservation = draft.requestReservations.get(request.id);
      if (request.singleUse && reservation && reservation !== command.payload.delivery.id) {
        throw new ReceiverDomainError(
          'SINGLE_USE_CONFLICT',
          'Single-use request is already claimed',
        );
      }
      return undefined;
    });
  }

  async withRedemptionLock<T>(
    deliveryId: string,
    operation: (lockedStore: ReceiverStore) => Promise<T>,
  ): Promise<{ readonly acquired: false } | { readonly acquired: true; readonly value: T }> {
    if (this.#redemptionLocks.has(deliveryId)) return { acquired: false };
    this.#redemptionLocks.add(deliveryId);
    try {
      return { acquired: true, value: await operation(this) };
    } finally {
      this.#redemptionLocks.delete(deliveryId);
    }
  }

  async prepare(input: PrepareDelivery): Promise<PrepareResult> {
    return this.#transaction((draft) => {
      const payload = input.command.payload;
      const request = draft.requests.get(payload.id);
      if (!request) throw new ReceiverDomainError('REQUEST_NOT_FOUND', 'Payment request not found');
      validateRequestBinding(request, input.command, input.now);
      if (input.netAmount !== request.amount) {
        throw new ReceiverDomainError('AMOUNT_MISMATCH', 'Delivery amount does not match request');
      }
      if (
        input.proofClaimIds.length !== payload.proofs.length ||
        input.proofYs.length !== payload.proofs.length ||
        new Set(input.proofClaimIds).size !== input.proofClaimIds.length ||
        input.proofSetHash.length === 0
      ) {
        throw new ReceiverDomainError('INVALID_PROOF_EVIDENCE', 'Proof evidence is incomplete');
      }

      const previous = draft.deliveries.get(payload.delivery.id);
      if (previous) {
        if (!sameDelivery(previous, input)) {
          throw new ReceiverDomainError('DELIVERY_CONFLICT', 'Delivery ID is already bound');
        }
        return { kind: 'duplicate', record: structuredClone(previous) };
      }

      for (const claim of input.proofClaimIds) {
        const owner = draft.proofClaims.get(claim);
        if (owner && owner !== payload.delivery.id) {
          throw new ReceiverDomainError('PROOF_CONFLICT', 'Proof is already claimed');
        }
      }
      const reservation = draft.requestReservations.get(request.id);
      if (request.singleUse && reservation && reservation !== payload.delivery.id) {
        throw new ReceiverDomainError(
          'SINGLE_USE_CONFLICT',
          'Single-use request is already claimed',
        );
      }

      const receipt: DeliveryReceipt = {
        profile: 'cashu-delivery-v1',
        requestId: request.id,
        deliveryId: payload.delivery.id,
        payloadHash: input.command.payloadHash,
        status: 'processing',
        statusVersion: 1,
        mint: payload.mint,
        unit: payload.unit,
        amount: request.amount,
        detailCode: 'accepted',
      };
      assertReceiptTransition(undefined, receipt);
      const record: DeliveryRecord = {
        requestId: request.id,
        deliveryId: payload.delivery.id,
        payloadHash: input.command.payloadHash,
        proofSetHash: input.proofSetHash,
        proofClaimIds: [...input.proofClaimIds],
        plan: structuredClone(input.plan),
        amount: request.amount,
        phase: 'prepared',
        receipt,
      };
      draft.deliveries.set(record.deliveryId, record);
      for (const claim of record.proofClaimIds) draft.proofClaims.set(claim, record.deliveryId);
      if (request.singleUse) draft.requestReservations.set(request.id, record.deliveryId);
      return { kind: 'prepared', record: structuredClone(record) };
    });
  }

  async markMintSent(deliveryId: string): Promise<DeliveryReceipt> {
    return this.#transaction((draft) => {
      const record = this.#requireDelivery(draft, deliveryId);
      if (record.phase !== 'prepared') return structuredClone(record.receipt);
      const receipt = nextReceipt(record.receipt, 'processing', 'redeeming');
      draft.deliveries.set(deliveryId, { ...record, phase: 'mint_sent', receipt });
      return structuredClone(receipt);
    });
  }

  async settle(input: CommitSettlement): Promise<DeliveryReceipt> {
    return this.#transaction((draft) => {
      const record = this.#requireDelivery(draft, input.deliveryId);
      if (record.phase === 'settled') {
        if (record.replacementPlanHash !== input.replacementPlanHash) {
          throw new ReceiverDomainError('INVALID_STATE', 'Settlement result is conflicting');
        }
        return structuredClone(record.receipt);
      }
      if (record.phase === 'rejected') {
        throw new ReceiverDomainError('INVALID_STATE', 'Rejected delivery cannot settle');
      }
      if (record.phase === 'prepared') {
        throw new ReceiverDomainError(
          'INVALID_STATE',
          'Delivery cannot settle before mint dispatch is durable',
        );
      }
      if (input.replacementPlanHash.length === 0 || input.replacementProofs.length === 0) {
        throw new ReceiverDomainError('INVALID_STATE', 'Recovered outputs are required to settle');
      }
      assertSafeInteger(input.now, 'Settlement time');
      const receipt = nextReceipt(record.receipt, 'settled', 'settled');
      const credit: MerchantCredit = {
        creditId: record.deliveryId,
        requestId: record.requestId,
        deliveryId: record.deliveryId,
        amount: record.amount,
        unit: record.receipt.unit,
        createdAt: input.now,
      };
      const previousCredit = draft.credits.get(record.deliveryId);
      if (previousCredit && JSON.stringify(previousCredit) !== JSON.stringify(credit)) {
        throw new ReceiverDomainError('INVALID_STATE', 'Merchant credit is conflicting');
      }
      draft.credits.set(record.deliveryId, previousCredit ?? credit);
      draft.deliveries.set(record.deliveryId, {
        ...record,
        phase: 'settled',
        receipt,
        replacementPlanHash: input.replacementPlanHash,
        replacementProofs: [...input.replacementProofs],
      });
      return structuredClone(receipt);
    });
  }

  async blockRecovery(deliveryId: string): Promise<DeliveryReceipt> {
    return this.#transaction((draft) => {
      const record = this.#requireDelivery(draft, deliveryId);
      if (record.phase === 'settled' || record.phase === 'recovery_blocked') {
        return structuredClone(record.receipt);
      }
      if (record.phase === 'rejected') {
        throw new ReceiverDomainError('INVALID_STATE', 'Rejected delivery cannot block recovery');
      }
      const receipt = nextReceipt(record.receipt, 'processing', 'recovery_blocked');
      draft.deliveries.set(deliveryId, { ...record, phase: 'recovery_blocked', receipt });
      return structuredClone(receipt);
    });
  }

  async reject(
    deliveryId: string,
    detailCode: string,
    releaseClaims: boolean,
  ): Promise<DeliveryReceipt> {
    return this.#transaction((draft) => {
      const record = this.#requireDelivery(draft, deliveryId);
      if (record.phase === 'rejected') return structuredClone(record.receipt);
      if (record.phase === 'settled' || record.phase === 'recovery_blocked') {
        throw new ReceiverDomainError('INVALID_STATE', 'Possibly consumed delivery cannot reject');
      }
      const receipt = nextReceipt(record.receipt, 'rejected', detailCode);
      draft.deliveries.set(deliveryId, { ...record, phase: 'rejected', receipt });
      if (releaseClaims) {
        for (const claim of record.proofClaimIds) {
          if (draft.proofClaims.get(claim) === deliveryId) draft.proofClaims.delete(claim);
        }
        if (draft.requestReservations.get(record.requestId) === deliveryId) {
          draft.requestReservations.delete(record.requestId);
        }
      }
      return structuredClone(receipt);
    });
  }

  async current(deliveryId: string): Promise<DeliveryRecord | undefined> {
    return this.#transaction((draft) => {
      const record = draft.deliveries.get(deliveryId);
      return record ? structuredClone(record) : undefined;
    });
  }

  async settlementPlans(): Promise<readonly ExactSwapPlanView[]> {
    return [...this.#state.deliveries.values()].map((record) => ({
      deliveryId: record.deliveryId,
      mint: record.plan.mint,
      unit: record.plan.unit,
      expectedAmount: record.plan.expectedAmount,
    }));
  }

  async credits(): Promise<readonly MerchantCredit[]> {
    return structuredClone([...this.#state.credits.values()]);
  }

  #requireDelivery(state: StoreState, deliveryId: string): DeliveryRecord {
    const record = state.deliveries.get(deliveryId);
    if (!record) throw new ReceiverDomainError('INVALID_STATE', 'Delivery does not exist');
    return record;
  }

  async #transaction<T>(operation: (draft: StoreState) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const draft = structuredClone(this.#state);
      const result = await operation(draft);
      this.#state = draft;
      return result;
    } finally {
      release();
    }
  }
}
