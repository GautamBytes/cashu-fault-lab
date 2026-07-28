import type { DeliveryPayload, DeliveryReceipt, ProtocolId } from '@cashu-fault-lab/delivery-core';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SenderPaymentRequest } from './send-payment.js';
import type { TransportTarget } from './ports/transport.js';

export type SenderDeliveryStatus = 'sending' | 'settled' | 'rejected' | 'recovery_required';

export type SenderAttemptStage = 'transport' | 'receipt_validation';
export type SenderAttemptCode =
  | 'TRANSPORT_FAILURE'
  | 'PERMANENT_FAILURE'
  | 'INVALID_RECEIPT'
  | 'RECEIPT_IDENTITY_CONFLICT'
  | 'RECEIPT_TRANSITION_CONFLICT';

export interface SenderAttemptDiagnostic {
  readonly attempt: number;
  readonly transport: TransportTarget['type'];
  readonly stage: SenderAttemptStage;
  readonly code: SenderAttemptCode;
  readonly retryable: boolean;
}

export interface SenderDeliveryRecord {
  readonly deliveryId: ProtocolId;
  readonly request: SenderPaymentRequest;
  readonly payload: DeliveryPayload;
  readonly payloadBytes: Uint8Array;
  readonly payloadHash: string;
  readonly target: TransportTarget;
  readonly status: SenderDeliveryStatus;
  readonly attempts: number;
  readonly receipt?: DeliveryReceipt;
  readonly diagnostics?: readonly SenderAttemptDiagnostic[];
}

const DIAGNOSTIC_KEYS = ['attempt', 'code', 'retryable', 'stage', 'transport'] as const;
const DIAGNOSTIC_STAGES = new Set<SenderAttemptStage>(['transport', 'receipt_validation']);
const DIAGNOSTIC_CODES = new Set<SenderAttemptCode>([
  'TRANSPORT_FAILURE',
  'PERMANENT_FAILURE',
  'INVALID_RECEIPT',
  'RECEIPT_IDENTITY_CONFLICT',
  'RECEIPT_TRANSITION_CONFLICT',
]);

export function assertSenderAttemptDiagnostics(
  value: unknown,
): asserts value is readonly SenderAttemptDiagnostic[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('Sender attempt diagnostics are invalid');
  }
  for (const item of value) {
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== DIAGNOSTIC_KEYS.join(',')
    ) {
      throw new Error('Sender attempt diagnostics are invalid');
    }
    const record = item as Readonly<Record<string, unknown>>;
    if (
      typeof record.attempt !== 'number' ||
      !Number.isSafeInteger(record.attempt) ||
      record.attempt < 1 ||
      (record.transport !== 'post' && record.transport !== 'nostr') ||
      !DIAGNOSTIC_STAGES.has(record.stage as SenderAttemptStage) ||
      !DIAGNOSTIC_CODES.has(record.code as SenderAttemptCode) ||
      typeof record.retryable !== 'boolean'
    ) {
      throw new Error('Sender attempt diagnostics are invalid');
    }
  }
}

export interface SenderStateOperations {
  create(record: SenderDeliveryRecord): Promise<void>;
  get(deliveryId: string): Promise<SenderDeliveryRecord | undefined>;
  save(record: SenderDeliveryRecord): Promise<void>;
}

export interface SenderState extends SenderStateOperations {
  /**
   * Serializes a complete delivery operation across every client or process sharing this state.
   * Durable adapters must bind the scoped operations to the same lock/session. The callback does
   * not expose lock acquisition, and implementations must reject nested lock attempts.
   */
  withDeliveryLock<T>(
    deliveryId: string,
    operation: (state: SenderStateOperations) => Promise<T>,
  ): Promise<T>;
}

export class InMemorySenderState implements SenderState {
  readonly #records = new Map<string, SenderDeliveryRecord>();
  readonly #deliveryOperations = new Map<string, Promise<void>>();
  readonly #lockScope = new AsyncLocalStorage<boolean>();

  async withDeliveryLock<T>(
    deliveryId: string,
    operation: (state: SenderStateOperations) => Promise<T>,
  ): Promise<T> {
    if (this.#lockScope.getStore()) {
      throw new Error('Nested sender delivery-lock acquisition is not allowed');
    }

    const previous = this.#deliveryOperations.get(deliveryId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#deliveryOperations.set(deliveryId, tail);

    await previous;
    try {
      return await this.#lockScope.run(true, () => operation(this));
    } finally {
      release();
      if (this.#deliveryOperations.get(deliveryId) === tail) {
        this.#deliveryOperations.delete(deliveryId);
      }
    }
  }

  async create(record: SenderDeliveryRecord): Promise<void> {
    if (this.#records.has(record.deliveryId)) throw new Error('Sender delivery ID already exists');
    assertSenderAttemptDiagnostics(record.diagnostics);
    this.#records.set(record.deliveryId, structuredClone(record));
  }

  async get(deliveryId: string): Promise<SenderDeliveryRecord | undefined> {
    const record = this.#records.get(deliveryId);
    return record ? structuredClone(record) : undefined;
  }

  async save(record: SenderDeliveryRecord): Promise<void> {
    if (!this.#records.has(record.deliveryId)) throw new Error('Sender delivery does not exist');
    assertSenderAttemptDiagnostics(record.diagnostics);
    this.#records.set(record.deliveryId, structuredClone(record));
  }
}
