import type { DeliveryReceiptWire } from '@cashu-fault-lab/delivery-core';

export interface TransportTarget {
  readonly type: 'post' | 'nostr';
  readonly target: string;
  readonly tags?: readonly (readonly string[])[];
}

export type TransportResult =
  | { readonly kind: 'receipt'; readonly receipt: DeliveryReceiptWire }
  | { readonly kind: 'no_response' };

export interface PaymentTransport {
  send(payload: Uint8Array, target: TransportTarget, signal: AbortSignal): Promise<TransportResult>;
}
