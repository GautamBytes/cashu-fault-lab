import { recoverDelivery } from './domain/recover-delivery.js';
import type { AcceptDeliveryDependencies } from './domain/accept-delivery.js';
import type { PostgresReceiverStore } from './adapters/postgres-store.js';

export interface RecoveryWorkerDependencies extends Omit<AcceptDeliveryDependencies, 'store'> {
  readonly store: PostgresReceiverStore;
}

export class RecoveryWorker {
  readonly #deps: RecoveryWorkerDependencies;

  constructor(deps: RecoveryWorkerDependencies) {
    this.#deps = deps;
  }

  async runOnce(limit = 100): Promise<number> {
    const deliveryIds = await this.#deps.store.recoverableDeliveryIds(limit);
    let recovered = 0;
    for (const deliveryId of deliveryIds) {
      const receipt = await recoverDelivery(deliveryId, this.#deps);
      if (receipt.status === 'settled' || receipt.status === 'rejected') recovered += 1;
    }
    return recovered;
  }
}
