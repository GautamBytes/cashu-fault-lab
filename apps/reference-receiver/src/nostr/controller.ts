import { serializeDeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import {
  unwrapDelivery,
  wrapDelivery,
  type WrapDeliveryOptions,
} from '@cashu-fault-lab/nostr-delivery';
import type { AcceptDeliveryDependencies } from '../domain/accept-delivery.js';
import { acceptPayloadBytes } from '../domain/accept-payload.js';

export interface ProcessNostrDeliveryOptions {
  readonly receiverPrivateKey: Uint8Array;
  readonly accept: AcceptDeliveryDependencies;
  readonly relayUrl?: string;
  readonly randomSecretKey?: WrapDeliveryOptions['randomSecretKey'];
  readonly randomNonce?: WrapDeliveryOptions['randomNonce'];
  readonly randomOffsetSeconds?: WrapDeliveryOptions['randomOffsetSeconds'];
}

export async function processNostrDelivery(
  wrappedRequest: Parameters<typeof unwrapDelivery>[0],
  options: ProcessNostrDeliveryOptions,
): Promise<ReturnType<typeof wrapDelivery>> {
  const request = unwrapDelivery(wrappedRequest, options.receiverPrivateKey);
  const receipt = await acceptPayloadBytes(request.payloadBytes, options.accept);
  const receiptBytes = new TextEncoder().encode(JSON.stringify(serializeDeliveryReceipt(receipt)));
  return wrapDelivery(receiptBytes, {
    senderPrivateKey: options.receiverPrivateKey,
    receiverPublicKey: request.senderPublicKey,
    now: options.accept.now(),
    ...(options.relayUrl === undefined ? {} : { relayUrl: options.relayUrl }),
    ...(options.randomSecretKey === undefined ? {} : { randomSecretKey: options.randomSecretKey }),
    ...(options.randomNonce === undefined ? {} : { randomNonce: options.randomNonce }),
    ...(options.randomOffsetSeconds === undefined
      ? {}
      : { randomOffsetSeconds: options.randomOffsetSeconds }),
  });
}
