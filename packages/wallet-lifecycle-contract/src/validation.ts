import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type {
  LifecycleRequestOperation,
  LifecycleResponseOperation,
  LifecycleSchemaErrorCode,
  LifecycleValidationResult,
} from './types.js';

const SAFE_INTEGER = 9_007_199_254_740_991;
const OPERATION_ID_PATTERN = '^[A-Za-z0-9_-]{21}[AQgw]$';
const HASH_PATTERN = '^[a-f0-9]{64}$';
const IDENTIFIER_PATTERN = '^[a-z0-9][a-z0-9_.-]{0,63}$';
const UNIT_PATTERN = '^[a-z0-9_-]{1,16}$';

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat('canonical-mint-url', {
  type: 'string',
  validate(value: string): boolean {
    try {
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== ''
      ) {
        return false;
      }
      const pathname =
        url.pathname === '/'
          ? ''
          : url.pathname.endsWith('/')
            ? url.pathname.slice(0, -1)
            : url.pathname;
      return `${url.protocol}//${url.host}${pathname}` === value;
    } catch {
      return false;
    }
  },
});

const operationId = { type: 'string', pattern: OPERATION_ID_PATTERN } as const;
const mintUrl = { type: 'string', format: 'canonical-mint-url' } as const;
const unit = { type: 'string', pattern: UNIT_PATTERN } as const;
const amount = { type: 'integer', minimum: 1, maximum: SAFE_INTEGER } as const;
const nonNegativeAmount = { type: 'integer', minimum: 0, maximum: SAFE_INTEGER } as const;
const hash = { type: 'string', pattern: HASH_PATTERN } as const;
const identifier = { type: 'string', pattern: IDENTIFIER_PATTERN } as const;

const commonInput = {
  operationId,
  mint: mintUrl,
  unit,
} as const;

function operationInput(
  kind: string,
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['operationId', 'kind', 'mint', 'unit', ...required],
    properties: { ...commonInput, kind: { const: kind }, ...properties },
  };
}

const startSchema = {
  oneOf: [
    operationInput('mint', ['amount', 'method'], { amount, method: { const: 'bolt11' } }),
    operationInput('swap', ['amount'], { amount }),
    operationInput('send', ['amount', 'recipient'], { amount, recipient: identifier }),
    operationInput('receive', ['token'], {
      token: { type: 'string', minLength: 1, maxLength: 262_144 },
    }),
    operationInput('melt', ['invoice'], {
      invoice: { type: 'string', minLength: 1, maxLength: 16_384 },
      preferAsync: { type: 'boolean' },
    }),
    operationInput('restore', [], {}),
    operationInput('reconcile', ['targetOperationId'], { targetOperationId: operationId }),
  ],
} as const;

const resetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['seed'],
  properties: { seed: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;

const resumeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operationId'],
  properties: { operationId },
} as const;

const implementationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'language', 'runtime', 'sourceDigest', 'buildDigest'],
  properties: {
    id: identifier,
    version: { type: 'string', minLength: 1, maxLength: 128 },
    language: identifier,
    runtime: { type: 'string', minLength: 1, maxLength: 128 },
    sourceDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    buildDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
  },
} as const;

const capabilitiesSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'implementation',
    'operations',
    'nuts',
    'durability',
    'recovery',
    'mints',
  ],
  properties: {
    schemaVersion: { const: 1 },
    implementation: implementationSchema,
    operations: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: ['mint', 'swap', 'send', 'receive', 'melt', 'restore', 'reconcile'] },
    },
    nuts: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'integer', minimum: 0, maximum: 10_000 },
    },
    durability: { enum: ['process', 'persistent', 'restart_safe'] },
    recovery: {
      type: 'array',
      uniqueItems: true,
      items: {
        enum: ['quote_state', 'proof_state', 'nut09_restore', 'nut13_seed', 'nut19_replay'],
      },
    },
    mints: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'implementation'],
        properties: {
          id: identifier,
          implementation: identifier,
          version: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
  },
} as const;

const operationViewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operationId', 'kind', 'mint', 'unit', 'intentHash', 'phase'],
  properties: {
    operationId,
    kind: { enum: ['mint', 'swap', 'send', 'receive', 'melt', 'restore', 'reconcile'] },
    mint: mintUrl,
    unit,
    intentHash: hash,
    phase: {
      enum: [
        'created',
        'prepared',
        'submitted',
        'ambiguous',
        'reconciling',
        'succeeded',
        'failed_definitive',
        'recovery_blocked',
      ],
    },
    evidenceCode: { type: 'string', pattern: '^[a-z0-9_]{1,64}$' },
    amount: nonNegativeAmount,
    inputFee: nonNegativeAmount,
    feeReserve: nonNegativeAmount,
    actualFee: nonNegativeAmount,
    change: nonNegativeAmount,
    requestHash: hash,
    quoteHash: hash,
    outputPlanHash: hash,
  },
} as const;

const walletSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['walletId', 'mint', 'unit', 'balances', 'proofs'],
  properties: {
    walletId: identifier,
    mint: mintUrl,
    unit,
    balances: {
      type: 'object',
      additionalProperties: false,
      required: ['available', 'reserved', 'recoverable'],
      properties: {
        available: nonNegativeAmount,
        reserved: nonNegativeAmount,
        recoverable: nonNegativeAmount,
      },
    },
    proofs: {
      type: 'array',
      maxItems: 10_000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['proofId', 'state'],
        properties: { proofId: hash, state: { enum: ['UNSPENT', 'PENDING', 'SPENT'] } },
      },
    },
  },
} as const;

const evidenceSchema = {
  type: 'array',
  maxItems: 100_000,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['sequence', 'operationId', 'source', 'event', 'dataHash'],
    properties: {
      sequence: nonNegativeAmount,
      operationId,
      source: { enum: ['adapter', 'durable_state', 'mint', 'lightning'] },
      event: { type: 'string', pattern: '^[a-z0-9_]{1,64}$' },
      dataHash: hash,
    },
  },
} as const;

const okSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { const: true } },
} as const;

const requestValidators: Readonly<Record<LifecycleRequestOperation, ValidateFunction>> = {
  reset: ajv.compile(resetSchema),
  start: ajv.compile(startSchema),
  resume: ajv.compile(resumeSchema),
};

const responseValidators: Readonly<Record<LifecycleResponseOperation, ValidateFunction>> = {
  capabilities: ajv.compile(capabilitiesSchema),
  reset: ajv.compile(okSchema),
  start: ajv.compile(operationViewSchema),
  resume: ajv.compile(operationViewSchema),
  operation: ajv.compile(operationViewSchema),
  wallet: ajv.compile(walletSchema),
  evidence: ajv.compile(evidenceSchema),
};

const errorCodes: Readonly<Record<string, LifecycleSchemaErrorCode>> = {
  additionalProperties: 'SCHEMA_ADDITIONAL_PROPERTY',
  const: 'SCHEMA_CONST',
  enum: 'SCHEMA_ENUM',
  format: 'SCHEMA_FORMAT',
  maximum: 'SCHEMA_MAXIMUM',
  maxItems: 'SCHEMA_MAX_ITEMS',
  minimum: 'SCHEMA_MINIMUM',
  minItems: 'SCHEMA_MIN_ITEMS',
  minLength: 'SCHEMA_MIN_LENGTH',
  oneOf: 'SCHEMA_ONE_OF',
  pattern: 'SCHEMA_PATTERN',
  required: 'SCHEMA_REQUIRED',
  type: 'SCHEMA_TYPE',
  uniqueItems: 'SCHEMA_UNIQUE_ITEMS',
};

const errorPriority = [
  'format',
  'maximum',
  'minimum',
  'pattern',
  'additionalProperties',
  'required',
  'const',
  'oneOf',
  'enum',
  'type',
] as const;

function selectError(errors: readonly ErrorObject[]): ErrorObject {
  for (const keyword of errorPriority) {
    const match = errors.find((error) => error.keyword === keyword);
    if (match !== undefined) return match;
  }
  return errors[0]!;
}

function validate(validator: ValidateFunction, value: unknown): LifecycleValidationResult {
  if (validator(value)) return { ok: true };
  const error = selectError(validator.errors ?? []);
  return {
    ok: false,
    errorCode: errorCodes[error.keyword] ?? 'SCHEMA_VALIDATION',
    path: error.instancePath,
    message: error.message ?? 'Schema validation failed',
  };
}

function hasOwn<T extends string>(
  record: Readonly<Record<string, unknown>>,
  key: T,
): record is Readonly<Record<string, unknown>> & Record<T, unknown> {
  return Object.hasOwn(record, key);
}

function unknownOperation(): LifecycleValidationResult {
  return {
    ok: false,
    errorCode: 'UNKNOWN_OPERATION',
    path: '',
    message: 'Unknown lifecycle adapter operation',
  };
}

export function validateLifecycleRequest(
  operation: LifecycleRequestOperation,
  value: unknown,
): LifecycleValidationResult {
  if (!hasOwn(requestValidators, operation)) return unknownOperation();
  return validate(requestValidators[operation], value);
}

export function validateLifecycleResponse(
  operation: LifecycleResponseOperation,
  value: unknown,
): LifecycleValidationResult {
  if (!hasOwn(responseValidators, operation)) return unknownOperation();
  return validate(responseValidators[operation], value);
}
