export type DeliveryErrorCode =
  | 'INVALID_PROTOCOL_ID'
  | 'INVALID_RANDOM_SOURCE'
  | 'INVALID_MINT_URL'
  | 'INSECURE_MINT_URL'
  | 'INVALID_RECEIPT'
  | 'RECEIPT_IDENTITY_MISMATCH'
  | 'STATUS_REGRESSION'
  | 'STATUS_VERSION_CONFLICT'
  | 'INVALID_PROOF_POINT';

export class DeliveryValidationError extends Error {
  readonly code: DeliveryErrorCode;

  constructor(code: DeliveryErrorCode, message: string) {
    super(message);
    this.name = 'DeliveryValidationError';
    this.code = code;
  }
}
