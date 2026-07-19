import type { DeliveryPayload, DeliveryReceipt, ProtocolId } from '@cashu-fault-lab/delivery-core';
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

export interface SenderState {
  create(record: SenderDeliveryRecord): Promise<void>;
  get(deliveryId: string): Promise<SenderDeliveryRecord | undefined>;
  save(record: SenderDeliveryRecord): Promise<void>;
}

export class InMemorySenderState implements SenderState {
  readonly #records = new Map<string, SenderDeliveryRecord>();

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
