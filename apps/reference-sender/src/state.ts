import type { DeliveryPayload, DeliveryReceipt, ProtocolId } from '@cashu-fault-lab/delivery-core';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SenderPaymentRequest } from './send-payment.js';
import type { TransportTarget } from './ports/transport.js';

export type SenderDeliveryStatus = 'sending' | 'settled' | 'rejected' | 'recovery_required';

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
    this.#records.set(record.deliveryId, structuredClone(record));
  }

  async get(deliveryId: string): Promise<SenderDeliveryRecord | undefined> {
    const record = this.#records.get(deliveryId);
    return record ? structuredClone(record) : undefined;
  }

  async save(record: SenderDeliveryRecord): Promise<void> {
    if (!this.#records.has(record.deliveryId)) throw new Error('Sender delivery does not exist');
    this.#records.set(record.deliveryId, structuredClone(record));
  }
}
