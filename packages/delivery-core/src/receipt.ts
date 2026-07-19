import { DeliveryValidationError } from './errors';
import { parseProtocolId, type ProtocolId } from './ids';
import { normalizeMintUrl } from './mint-url';

export type DeliveryStatus = 'processing' | 'settled' | 'rejected';
export type ReceiptDetailCode =
  'accepted' | 'redeeming' | 'recovery_blocked' | 'settled' | 'invalid' | 'expired' | 'conflict';

export interface DeliveryReceipt {
  readonly profile: 'cashu-delivery-v1';
  readonly requestId: ProtocolId;
  readonly deliveryId: ProtocolId;
  readonly payloadHash: string;
  readonly status: DeliveryStatus;
  readonly statusVersion: number;
  readonly mint: string;
  readonly unit: string;
  readonly amount: number;
  readonly detailCode: ReceiptDetailCode;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const STATUS_DETAILS: Readonly<Record<DeliveryStatus, ReadonlySet<ReceiptDetailCode>>> = {
  processing: new Set(['accepted', 'redeeming', 'recovery_blocked']),
  settled: new Set(['settled']),
  rejected: new Set(['invalid', 'expired', 'conflict']),
};

function assertValidReceipt(receipt: DeliveryReceipt): void {
  parseProtocolId(receipt.requestId);
  parseProtocolId(receipt.deliveryId);
  if (
    receipt.profile !== 'cashu-delivery-v1' ||
    !HASH_PATTERN.test(receipt.payloadHash) ||
    !Number.isSafeInteger(receipt.statusVersion) ||
    receipt.statusVersion < 1 ||
    !Number.isSafeInteger(receipt.amount) ||
    receipt.amount < 0 ||
    receipt.unit.length === 0 ||
    receipt.mint.length === 0 ||
    normalizeMintUrl(receipt.mint) !== receipt.mint ||
    !STATUS_DETAILS[receipt.status]?.has(receipt.detailCode)
  ) {
    throw new DeliveryValidationError('INVALID_RECEIPT', 'Delivery receipt is invalid');
  }
}

function sameIdentity(previous: DeliveryReceipt, next: DeliveryReceipt): boolean {
  return (
    previous.profile === next.profile &&
    previous.requestId === next.requestId &&
    previous.deliveryId === next.deliveryId &&
    previous.payloadHash === next.payloadHash &&
    previous.mint === next.mint &&
    previous.unit === next.unit &&
    previous.amount === next.amount
  );
}

function sameReceipt(previous: DeliveryReceipt, next: DeliveryReceipt): boolean {
  return (
    sameIdentity(previous, next) &&
    previous.status === next.status &&
    previous.statusVersion === next.statusVersion &&
    previous.detailCode === next.detailCode
  );
}

export function assertReceiptTransition(
  previous: DeliveryReceipt | undefined,
  next: DeliveryReceipt,
): void {
  assertValidReceipt(next);
  if (!previous) return;

  assertValidReceipt(previous);
  if (!sameIdentity(previous, next)) {
    throw new DeliveryValidationError(
      'RECEIPT_IDENTITY_MISMATCH',
      'Receipt identity cannot change',
    );
  }

  if (sameReceipt(previous, next)) return;

  if (next.statusVersion === previous.statusVersion) {
    throw new DeliveryValidationError(
      'STATUS_VERSION_CONFLICT',
      'Different receipt content cannot use the same version',
    );
  }

  if (
    next.statusVersion < previous.statusVersion ||
    previous.status === 'settled' ||
    previous.status === 'rejected'
  ) {
    throw new DeliveryValidationError('STATUS_REGRESSION', 'Receipt status cannot regress');
  }
}
