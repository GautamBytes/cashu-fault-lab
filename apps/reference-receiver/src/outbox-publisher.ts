import type { DeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import type { PostgresReceiverStore } from './adapters/postgres-store.js';

export type ReceiptPublisher = (receipt: DeliveryReceipt) => Promise<void>;

export class OutboxPublisher {
  readonly #store: PostgresReceiverStore;
  readonly #publish: ReceiptPublisher;

  constructor(store: PostgresReceiverStore, publish: ReceiptPublisher) {
    this.#store = store;
    this.#publish = publish;
  }

  runOnce(limit = 100): Promise<number> {
    return this.#store.publishOutboxBatch(this.#publish, limit);
  }
}
