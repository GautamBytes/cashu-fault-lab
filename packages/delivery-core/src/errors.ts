export type DeliveryErrorCode =
  | 'INVALID_PROTOCOL_ID'
  | 'INVALID_RANDOM_SOURCE'
  | 'INVALID_MINT_URL'
  | 'INSECURE_MINT_URL'
  | 'INVALID_RECEIPT'
  | 'RECEIPT_IDENTITY_MISMATCH'
  | 'STATUS_REGRESSION'
  | 'STATUS_VERSION_CONFLICT'
  | 'INVALID_FINGERPRINT_INPUT'
  | 'INVALID_PROOF_POINT'
  | 'DUPLICATE_PROOF_POINT'
  | 'INVALID_DELIVERY_NEGOTIATION'
  | 'INVALID_DELIVERY_PAYLOAD'
  | 'DELIVERY_EXPIRED'
  | 'INVALID_AMOUNT'
  | 'UNKNOWN_KEYSET'
  | 'AMOUNT_MISMATCH';

export class DeliveryValidationError extends Error {
  readonly code: DeliveryErrorCode;

  constructor(code: DeliveryErrorCode, message: string) {
    super(message);
    this.name = 'DeliveryValidationError';
    this.code = code;
  }
}
