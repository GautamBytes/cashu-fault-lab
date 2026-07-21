import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  adapterCapabilitiesSchema,
  deliveryPayloadSchema,
  deliveryReceiptSchema,
  deliveryRequestSchema,
  scenarioResultSchema,
  scenarioSpecSchema,
} from './schemas.js';
import { normalizeMintUrl } from '@cashu-fault-lab/delivery-core';
import type {
  AdapterRequestOperation,
  AdapterResponseOperation,
  SchemaErrorCode,
  ValidationResult,
} from './types.js';

const PROTOCOL_ID_PATTERN = '^[A-Za-z0-9_-]{21}[AQgw]$';
const HASH_PATTERN = '^[0-9a-f]{64}$';
const POINT_PATTERN = '^(02|03)[0-9a-fA-F]{64}$';
const SAFE_INTEGER = 9_007_199_254_740_991;

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
ajv.addFormat('cashu-mint-url', {
  type: 'string',
  validate(value: string): boolean {
    try {
      normalizeMintUrl(value);
      return true;
    } catch {
      return false;
    }
  },
});
ajv.addFormat('cashu-canonical-mint-url', {
  type: 'string',
  validate(value: string): boolean {
    try {
      return normalizeMintUrl(value) === value;
    } catch {
      return false;
    }
  },
});

const validators = {
  deliveryRequest: ajv.compile(deliveryRequestSchema),
  deliveryPayload: ajv.compile(deliveryPayloadSchema),
  deliveryReceipt: ajv.compile(deliveryReceiptSchema),
  capabilities: ajv.compile(adapterCapabilitiesSchema),
  scenarioResult: ajv.compile(scenarioResultSchema),
  scenarioSpec: ajv.compile(scenarioSpecSchema),
} as const;

const resetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['seed'],
  properties: { seed: { type: 'string', minLength: 1 } },
} as const;

const createRequestInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['amount', 'unit', 'transports', 'singleUse', 'expiresIn'],
  properties: {
    amount: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
    unit: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    transports: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: ['http', 'nostr'] },
    },
    singleUse: { type: 'boolean' },
    expiresIn: { type: 'integer', minimum: 1, maximum: 86_400 },
  },
} as const;

const sendInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['request'],
  properties: {
    request: { type: 'string', minLength: 1 },
    deliveryId: { type: 'string', pattern: PROTOCOL_ID_PATTERN },
    memo: { type: ['string', 'null'] },
  },
} as const;

const resetResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { const: true } },
} as const;

const transportViewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'target'],
  properties: {
    type: { enum: ['post', 'nostr'] },
    target: { type: 'string', minLength: 1 },
    tags: {
      type: 'array',
      items: { type: 'array', minItems: 2, items: { type: 'string' } },
    },
  },
} as const;

const createRequestResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'raw', 'amount', 'unit', 'singleUse', 'expiresAt', 'transports'],
  properties: {
    id: { type: 'string', pattern: PROTOCOL_ID_PATTERN },
    raw: { type: 'string', minLength: 1 },
    amount: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
    unit: { type: 'string', minLength: 1 },
    singleUse: { type: 'boolean' },
    expiresAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
    transports: { type: 'array', minItems: 1, items: transportViewSchema },
  },
} as const;

const ledgerResponseSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['requestId', 'deliveryId', 'amount', 'unit', 'creditCount', 'createdAt'],
    properties: {
      requestId: { type: 'string', pattern: PROTOCOL_ID_PATTERN },
      deliveryId: { type: 'string', pattern: PROTOCOL_ID_PATTERN },
      amount: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
      unit: { type: 'string', minLength: 1 },
      creditCount: { type: 'integer', minimum: 1, maximum: SAFE_INTEGER },
      createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
    },
  },
} as const;

const proofResponseSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['deliveryId', 'proofSetHash', 'inputYs', 'state'],
    properties: {
      deliveryId: { type: 'string', pattern: PROTOCOL_ID_PATTERN },
      proofSetHash: { type: 'string', pattern: HASH_PATTERN },
      inputYs: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', pattern: POINT_PATTERN },
      },
      state: { enum: ['unspent', 'pending', 'spent', 'unknown'] },
    },
  },
} as const;

const requestValidators: Readonly<Record<AdapterRequestOperation, ValidateFunction>> = {
  reset: ajv.compile(resetSchema),
  createRequest: ajv.compile(createRequestInputSchema),
  send: ajv.compile(sendInputSchema),
};

const responseValidators: Readonly<Record<AdapterResponseOperation, ValidateFunction>> = {
  capabilities: validators.capabilities,
  reset: ajv.compile(resetResponseSchema),
  createRequest: ajv.compile(createRequestResponseSchema),
  send: validators.deliveryReceipt,
  delivery: validators.deliveryReceipt,
  ledger: ajv.compile(ledgerResponseSchema),
  proofs: ajv.compile(proofResponseSchema),
};

const ERROR_PRIORITY = [
  'additionalProperties',
  'required',
  'if',
  'contains',
  'const',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'enum',
  'type',
] as const;

const ERROR_CODES: Readonly<Record<string, SchemaErrorCode>> = {
  additionalProperties: 'SCHEMA_ADDITIONAL_PROPERTY',
  const: 'SCHEMA_CONST',
  contains: 'SCHEMA_CONTAINS',
  enum: 'SCHEMA_ENUM',
  format: 'SCHEMA_FORMAT',
  if: 'SCHEMA_IF',
  maximum: 'SCHEMA_MAXIMUM',
  maxItems: 'SCHEMA_MAX_ITEMS',
  minimum: 'SCHEMA_MINIMUM',
  minItems: 'SCHEMA_MIN_ITEMS',
  minLength: 'SCHEMA_MIN_LENGTH',
  pattern: 'SCHEMA_PATTERN',
  required: 'SCHEMA_REQUIRED',
  type: 'SCHEMA_TYPE',
  uniqueItems: 'SCHEMA_UNIQUE_ITEMS',
};

function selectError(errors: readonly ErrorObject[]): ErrorObject {
  for (const keyword of ERROR_PRIORITY) {
    const match = errors.find((error) => error.keyword === keyword);
    if (match) return match;
  }
  return errors[0]!;
}

function result(validator: ValidateFunction, value: unknown): ValidationResult {
  if (validator(value)) return { ok: true };
  const error = selectError(validator.errors ?? []);
  return {
    ok: false,
    errorCode: ERROR_CODES[error.keyword] ?? 'SCHEMA_VALIDATION',
    path: error.instancePath,
    message: error.message ?? 'Schema validation failed',
  };
}

function hasOwn<T extends string>(
  value: Readonly<Record<string, unknown>>,
  key: T,
): value is Record<T, unknown> {
  return Object.hasOwn(value, key);
}

function unknownOperation(): ValidationResult {
  return {
    ok: false,
    errorCode: 'UNKNOWN_OPERATION',
    path: '',
    message: 'Unknown adapter operation',
  };
}

export function validateDeliveryRequest(value: unknown): ValidationResult {
  return result(validators.deliveryRequest, value);
}

export function validateDeliveryPayload(value: unknown): ValidationResult {
  return result(validators.deliveryPayload, value);
}

export function validateDeliveryReceipt(value: unknown): ValidationResult {
  return result(validators.deliveryReceipt, value);
}

export function validateScenarioResult(value: unknown): ValidationResult {
  return result(validators.scenarioResult, value);
}

export function validateScenarioSpec(value: unknown): ValidationResult {
  return result(validators.scenarioSpec, value);
}

export function validateAdapterRequest(
  operation: AdapterRequestOperation,
  value: unknown,
): ValidationResult {
  if (!hasOwn(requestValidators, operation)) return unknownOperation();
  return result(requestValidators[operation], value);
}

export function validateAdapterResponse(
  operation: AdapterResponseOperation,
  value: unknown,
): ValidationResult {
  if (!hasOwn(responseValidators, operation)) return unknownOperation();
  return result(responseValidators[operation], value);
}
