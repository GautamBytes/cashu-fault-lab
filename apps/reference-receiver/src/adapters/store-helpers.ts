import { assertReceiptTransition, type DeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import type { PaymentRequestRecord, DeliveryRecord, PrepareDelivery } from '../domain/types.js';
import { ReceiverDomainError } from '../domain/types.js';

export function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReceiverDomainError('INVALID_REQUEST', `${name} must be a nonnegative safe integer`);
  }
}

export function nextReceipt(
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

export function sameRequest(left: PaymentRequestRecord, right: PaymentRequestRecord): boolean {
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

export function sameDelivery(left: DeliveryRecord, input: PrepareDelivery): boolean {
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
