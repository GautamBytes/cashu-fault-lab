import {
  assertExactRequestedAmount,
  computePayloadHash,
  mergeObservedReceipt,
  parseDeliveryReceipt,
  parseProtocolId,
  serializeDeliveryPayload,
  type DeliveryPayload,
  type DeliveryReceipt,
  type ProtocolId,
} from '@cashu-fault-lab/delivery-core';
import type { PaymentTransport, TransportTarget } from './ports/transport.js';
import type { SenderWallet } from './ports/wallet.js';
import { createSeededRandom, retryDelay } from './retry.js';
import type {
  SenderAttemptCode,
  SenderAttemptDiagnostic,
  SenderDeliveryRecord,
  SenderState,
  SenderStateOperations,
} from './state.js';

export interface SenderPaymentRequest {
  readonly id: ProtocolId;
  readonly amount: number;
  readonly unit: string;
  readonly mints: readonly string[];
  readonly expiresAt: number;
  readonly transports: readonly TransportTarget[];
}

export interface SendPaymentDependencies {
  readonly wallet: SenderWallet;
  readonly transport: PaymentTransport;
  readonly state: SenderState;
  readonly now: () => number;
  readonly generateDeliveryId: () => ProtocolId;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface SendPaymentOptions {
  readonly seed: string;
  readonly maxAttempts?: number;
  readonly memo?: string | null;
}

export type SendPaymentOutcome =
  | {
      readonly status: 'settled' | 'rejected';
      readonly deliveryId: ProtocolId;
      readonly receipt: DeliveryReceipt;
    }
  | {
      readonly status: 'recovery_required';
      readonly deliveryId: ProtocolId;
      readonly receipt?: DeliveryReceipt;
    };

type SendPaymentOperationDependencies = Omit<SendPaymentDependencies, 'state'> & {
  readonly state: SenderStateOperations;
};

function validateMaxAttempts(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('Maximum attempts must be an integer from 1 to 100');
  }
}

function assertReceiptIdentity(record: SenderDeliveryRecord, receipt: DeliveryReceipt): void {
  if (
    receipt.requestId !== record.request.id ||
    receipt.deliveryId !== record.deliveryId ||
    receipt.payloadHash !== record.payloadHash ||
    receipt.mint !== record.payload.mint ||
    receipt.unit !== record.payload.unit ||
    receipt.amount !== record.request.amount
  ) {
    throw new Error('Receiver receipt does not match sender delivery identity');
  }
}

function appendDiagnostic(
  record: SenderDeliveryRecord,
  code: SenderAttemptCode,
  stage: SenderAttemptDiagnostic['stage'],
  retryable: boolean,
): SenderDeliveryRecord {
  const diagnostic: SenderAttemptDiagnostic = {
    attempt: record.attempts,
    transport: record.target.type,
    stage,
    code,
    retryable,
  };
  return {
    ...record,
    diagnostics: [...(record.diagnostics ?? []), diagnostic].slice(-20),
  };
}

async function markRecoveryAfterNonterminalFailure(
  deliveryId: ProtocolId,
  state: SenderStateOperations,
  wallet: SenderWallet,
  error: unknown,
): Promise<never> {
  let persisted: SenderDeliveryRecord | undefined;
  try {
    persisted = await state.get(deliveryId);
  } catch (stateError) {
    throw new AggregateError(
      [error, stateError],
      'Sender attempt failed and its terminal state could not be checked',
    );
  }

  if (persisted?.status === 'settled' || persisted?.status === 'rejected') throw error;

  try {
    await wallet.markRecoveryRequired(deliveryId);
  } catch (markError) {
    throw new AggregateError(
      [error, markError],
      'Sender attempt failed and could not mark recovery required',
    );
  }
  throw error;
}

async function runAttempts(
  initial: SenderDeliveryRecord,
  deps: SendPaymentOperationDependencies,
  options: SendPaymentOptions,
): Promise<SendPaymentOutcome> {
  const maxAttempts = options.maxAttempts ?? 5;
  validateMaxAttempts(maxAttempts);
  const random = createSeededRandom(options.seed);
  let record = initial;

  for (let localAttempt = 0; localAttempt < maxAttempts; localAttempt += 1) {
    let shouldRetry = true;
    const target =
      record.request.transports[Math.min(record.attempts, record.request.transports.length - 1)]!;
    record = { ...record, target: structuredClone(target), attempts: record.attempts + 1 };
    await deps.state.save(record);
    let result: Awaited<ReturnType<PaymentTransport['send']>> | undefined;
    try {
      result = await deps.transport.send(
        Uint8Array.from(record.payloadBytes),
        record.target,
        new AbortController().signal,
      );
    } catch {
      record = appendDiagnostic(record, 'TRANSPORT_FAILURE', 'transport', true);
    }

    if (result?.kind === 'receipt') {
      let receipt: DeliveryReceipt | undefined;
      let observed: DeliveryReceipt | undefined;
      try {
        observed = parseDeliveryReceipt(result.receipt);
      } catch {
        record = appendDiagnostic(record, 'INVALID_RECEIPT', 'receipt_validation', true);
      }
      if (observed !== undefined) {
        try {
          assertReceiptIdentity(record, observed);
        } catch {
          record = appendDiagnostic(
            record,
            'RECEIPT_IDENTITY_CONFLICT',
            'receipt_validation',
            false,
          );
          shouldRetry = false;
        }
      }
      if (observed !== undefined && shouldRetry) {
        try {
          receipt = mergeObservedReceipt(record.receipt, observed);
        } catch {
          record = appendDiagnostic(
            record,
            'RECEIPT_TRANSITION_CONFLICT',
            'receipt_validation',
            false,
          );
          shouldRetry = false;
        }
      }
      if (receipt) {
        record = { ...record, receipt };
        if (receipt.status === 'settled') {
          record = { ...record, status: 'settled' };
          await deps.state.save(record);
          await deps.wallet.markSettled(record.deliveryId);
          return { status: 'settled', deliveryId: record.deliveryId, receipt };
        }
        if (receipt.status === 'rejected') {
          record = { ...record, status: 'rejected' };
          await deps.state.save(record);
          await deps.wallet.releaseRejected(record.deliveryId);
          return { status: 'rejected', deliveryId: record.deliveryId, receipt };
        }
        if (receipt.detailCode === 'recovery_blocked') shouldRetry = false;
      }
    }
    if (result?.kind === 'no_response') {
      record = appendDiagnostic(record, 'TRANSPORT_FAILURE', 'transport', true);
    }
    if (result?.kind === 'permanent_failure') {
      record = appendDiagnostic(record, 'PERMANENT_FAILURE', 'transport', false);
      shouldRetry = false;
    }
    await deps.state.save(record);

    if (!shouldRetry || localAttempt === maxAttempts - 1) break;
    await deps.sleep(retryDelay({ attempt: localAttempt, random }));
  }

  record = { ...record, status: 'recovery_required' };
  await deps.state.save(record);
  await deps.wallet.markRecoveryRequired(record.deliveryId);
  return {
    status: 'recovery_required',
    deliveryId: record.deliveryId,
    ...(record.receipt ? { receipt: record.receipt } : {}),
  };
}

export async function sendPayment(
  request: SenderPaymentRequest,
  deps: SendPaymentDependencies,
  options: SendPaymentOptions,
): Promise<SendPaymentOutcome> {
  parseProtocolId(request.id);
  const now = deps.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Sender time is invalid');
  if (!Number.isSafeInteger(request.expiresAt) || request.expiresAt <= now) {
    throw new Error('Payment request has expired');
  }
  if (request.transports.length === 0 || request.mints.length === 0) {
    throw new Error('Payment request has no usable mint or transport');
  }
  validateMaxAttempts(options.maxAttempts ?? 5);
  createSeededRandom(options.seed);
  const deliveryId = deps.generateDeliveryId();
  parseProtocolId(deliveryId);
  return deps.state.withDeliveryLock(deliveryId, async (state) => {
    if (await state.get(deliveryId)) {
      throw new Error('Sender delivery ID already exists');
    }
    const reserved = await deps.wallet.reserveExact({
      deliveryId,
      amount: request.amount,
      unit: request.unit,
      mints: request.mints,
    });
    let record: SenderDeliveryRecord;
    try {
      if (!request.mints.includes(reserved.mint) || reserved.unit !== request.unit) {
        throw new Error('Reserved proofs do not match payment request');
      }
      assertExactRequestedAmount(reserved.netAmount, request.amount);
      const payload: DeliveryPayload = {
        id: request.id,
        memo: options.memo ?? null,
        mint: reserved.mint,
        unit: reserved.unit,
        proofs: reserved.proofs,
        delivery: {
          version: 1,
          id: deliveryId,
          createdAt: now,
          expiresAt: request.expiresAt,
        },
      };
      const payloadBytes = serializeDeliveryPayload(payload);
      const payloadHash = computePayloadHash({
        requestId: payload.id,
        memo: payload.memo,
        mint: payload.mint,
        unit: payload.unit,
        proofs: payload.proofs,
        createdAt: payload.delivery.createdAt,
        expiresAt: payload.delivery.expiresAt,
      });
      record = {
        deliveryId,
        request: structuredClone(request),
        payload,
        payloadBytes,
        payloadHash,
        target: structuredClone(request.transports[0]!),
        status: 'sending',
        attempts: 0,
      };
      await state.create(record);
    } catch (error) {
      try {
        await deps.wallet.markRecoveryRequired(deliveryId);
      } catch (markError) {
        throw new AggregateError(
          [error, markError],
          'Sender failed after reservation and could not mark recovery required',
        );
      }
      throw error;
    }
    try {
      return await runAttempts(record, { ...deps, state }, options);
    } catch (error) {
      return markRecoveryAfterNonterminalFailure(deliveryId, state, deps.wallet, error);
    }
  });
}

export async function resumePayment(
  deliveryId: string,
  deps: SendPaymentDependencies,
  options: SendPaymentOptions,
): Promise<SendPaymentOutcome> {
  return deps.state.withDeliveryLock(deliveryId, async (state) => {
    const record = await state.get(deliveryId);
    if (!record) throw new Error('Sender delivery does not exist');
    if (record.status === 'settled' && record.receipt) {
      await deps.wallet.markSettled(record.deliveryId);
      return { status: 'settled', deliveryId: record.deliveryId, receipt: record.receipt };
    }
    if (record.status === 'rejected' && record.receipt) {
      await deps.wallet.releaseRejected(record.deliveryId);
      return { status: 'rejected', deliveryId: record.deliveryId, receipt: record.receipt };
    }
    return runAttempts({ ...record, status: 'sending' }, { ...deps, state }, options);
  });
}
