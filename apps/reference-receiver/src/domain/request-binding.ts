import type { AcceptDeliveryCommand, DeliveryRecord, PaymentRequestRecord } from './types.js';
import { ReceiverDomainError } from './types.js';

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReceiverDomainError('INVALID_REQUEST', `${name} must be a nonnegative safe integer`);
  }
}

export function isSameDeliveryBinding(
  record: DeliveryRecord,
  command: AcceptDeliveryCommand,
): boolean {
  return (
    record.requestId === command.payload.id &&
    record.deliveryId === command.payload.delivery.id &&
    record.payloadHash === command.payloadHash &&
    record.plan.mint === command.payload.mint &&
    record.plan.unit === command.payload.unit
  );
}

export function validateRequestBinding(
  request: PaymentRequestRecord,
  command: AcceptDeliveryCommand,
  now: number,
): void {
  const payload = command.payload;
  assertSafeInteger(now, 'Current time');
  if (request.expiresAt < now - 60) {
    throw new ReceiverDomainError('REQUEST_EXPIRED', 'Payment request has expired');
  }
  if (payload.delivery.expiresAt < now - 60) {
    throw new ReceiverDomainError('DELIVERY_EXPIRED', 'Delivery has expired');
  }
  if (payload.delivery.createdAt > now + 60) {
    throw new ReceiverDomainError(
      'DELIVERY_TIME_INVALID',
      'Delivery creation time is too far in the future',
    );
  }
  if (payload.delivery.expiresAt !== request.expiresAt) {
    throw new ReceiverDomainError('REQUEST_MISMATCH', 'Delivery expiry does not match request');
  }
  if (payload.unit !== request.unit) {
    throw new ReceiverDomainError('UNIT_MISMATCH', 'Delivery unit does not match request');
  }
  if (!request.mints.includes(payload.mint)) {
    throw new ReceiverDomainError('MINT_MISMATCH', 'Delivery mint is not accepted');
  }
}
