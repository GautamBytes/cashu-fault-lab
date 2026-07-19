import { DeliveryValidationError } from './errors';
import { parseProtocolId, type ProtocolId } from './ids';
import { normalizeMintUrl } from './mint-url';

export type DeliveryStatus = 'processing' | 'settled' | 'rejected';
export type KnownReceiptDetailCode =
  'accepted' | 'redeeming' | 'recovery_blocked' | 'settled' | 'invalid' | 'expired' | 'conflict';
export type ReceiptDetailCode = KnownReceiptDetailCode | (string & {});

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

export interface DeliveryReceiptWire {
  readonly profile: 'cashu-delivery-v1';
  readonly request_id: string;
  readonly delivery_id: string;
  readonly payload_hash: string;
  readonly status: DeliveryStatus;
  readonly status_version: number;
  readonly mint: string;
  readonly unit: string;
  readonly amount: number;
  readonly detail_code: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const STATUS_DETAILS = new Map<DeliveryStatus, ReadonlySet<KnownReceiptDetailCode>>([
  ['processing', new Set(['accepted', 'redeeming', 'recovery_blocked'])],
  ['settled', new Set(['settled'])],
  ['rejected', new Set(['invalid', 'expired', 'conflict'])],
]);
const KNOWN_DETAIL_CODES = new Set<KnownReceiptDetailCode>([
  'accepted',
  'redeeming',
  'recovery_blocked',
  'settled',
  'invalid',
  'expired',
  'conflict',
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return value === 'processing' || value === 'settled' || value === 'rejected';
}

function hasValidDetailCode(status: DeliveryStatus, detailCode: string): boolean {
  if (detailCode.length === 0) return false;
  if (!KNOWN_DETAIL_CODES.has(detailCode as KnownReceiptDetailCode)) return true;
  return STATUS_DETAILS.get(status)?.has(detailCode as KnownReceiptDetailCode) === true;
}

function invalidReceipt(): never {
  throw new DeliveryValidationError('INVALID_RECEIPT', 'Delivery receipt is invalid');
}

function assertValidReceipt(receipt: unknown): asserts receipt is DeliveryReceipt {
  if (
    !isRecord(receipt) ||
    receipt.profile !== 'cashu-delivery-v1' ||
    typeof receipt.requestId !== 'string' ||
    typeof receipt.deliveryId !== 'string' ||
    typeof receipt.payloadHash !== 'string' ||
    !HASH_PATTERN.test(receipt.payloadHash) ||
    !isDeliveryStatus(receipt.status) ||
    typeof receipt.statusVersion !== 'number' ||
    !Number.isSafeInteger(receipt.statusVersion) ||
    receipt.statusVersion < 1 ||
    typeof receipt.amount !== 'number' ||
    !Number.isSafeInteger(receipt.amount) ||
    receipt.amount < 0 ||
    typeof receipt.unit !== 'string' ||
    receipt.unit.length === 0 ||
    typeof receipt.mint !== 'string' ||
    receipt.mint.length === 0 ||
    typeof receipt.detailCode !== 'string' ||
    !hasValidDetailCode(receipt.status, receipt.detailCode)
  ) {
    invalidReceipt();
  }

  parseProtocolId(receipt.requestId);
  parseProtocolId(receipt.deliveryId);
  if (normalizeMintUrl(receipt.mint) !== receipt.mint) invalidReceipt();
}

export function parseDeliveryReceipt(value: unknown): DeliveryReceipt {
  if (!isRecord(value)) invalidReceipt();

  const receipt = {
    profile: value.profile,
    requestId: value.request_id,
    deliveryId: value.delivery_id,
    payloadHash: value.payload_hash,
    status: value.status,
    statusVersion: value.status_version,
    mint: value.mint,
    unit: value.unit,
    amount: value.amount,
    detailCode: value.detail_code,
  };

  assertValidReceipt(receipt);
  return receipt;
}

export function serializeDeliveryReceipt(receipt: DeliveryReceipt): DeliveryReceiptWire {
  assertValidReceipt(receipt);
  return {
    profile: receipt.profile,
    request_id: receipt.requestId,
    delivery_id: receipt.deliveryId,
    payload_hash: receipt.payloadHash,
    status: receipt.status,
    status_version: receipt.statusVersion,
    mint: receipt.mint,
    unit: receipt.unit,
    amount: receipt.amount,
    detail_code: receipt.detailCode,
  };
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

  if (next.statusVersion !== previous.statusVersion + 1) {
    throw new DeliveryValidationError(
      'STATUS_VERSION_CONFLICT',
      'Receipt status version must increment by exactly one',
    );
  }

  if (next.status === previous.status && next.detailCode === previous.detailCode) {
    throw new DeliveryValidationError(
      'STATUS_VERSION_CONFLICT',
      'A status version increment must change status or detail',
    );
  }

  if (previous.detailCode === 'recovery_blocked' && next.status === 'rejected') {
    throw new DeliveryValidationError(
      'STATUS_REGRESSION',
      'A receipt cannot be rejected after inputs may have been consumed',
    );
  }
}

export function mergeObservedReceipt(
  previous: DeliveryReceipt | undefined,
  next: DeliveryReceipt,
): DeliveryReceipt {
  assertValidReceipt(next);
  if (!previous) return next;

  assertValidReceipt(previous);
  if (!sameIdentity(previous, next)) {
    throw new DeliveryValidationError(
      'RECEIPT_IDENTITY_MISMATCH',
      'Receipt identity cannot change',
    );
  }

  if (sameReceipt(previous, next)) return previous;
  if (next.statusVersion < previous.statusVersion) return previous;

  if (next.statusVersion === previous.statusVersion) {
    throw new DeliveryValidationError(
      'STATUS_VERSION_CONFLICT',
      'Different receipt content cannot use the same version',
    );
  }

  if (previous.status === 'settled' || previous.status === 'rejected') {
    throw new DeliveryValidationError('STATUS_REGRESSION', 'Terminal receipt status cannot change');
  }

  if (previous.detailCode === 'recovery_blocked' && next.status === 'rejected') {
    throw new DeliveryValidationError(
      'STATUS_REGRESSION',
      'A receipt cannot be rejected after inputs may have been consumed',
    );
  }

  return next;
}
