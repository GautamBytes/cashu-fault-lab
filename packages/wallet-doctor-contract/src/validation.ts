import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import type { Nip60Capture } from './types.js';

const HEX64 = '^[0-9a-f]{64}$';
const HEX128 = '^[0-9a-f]{128}$';
const COMPRESSED_POINT = '^0[23][0-9a-f]{64}$';
const DIGEST = '^sha256:[0-9a-f]{64}$';
const SAFE_INTEGER = 9_007_199_254_740_991;

/**
 * Canonical wire contract for the capture bundle. Mirrored by
 * `spec/schemas/nip60-capture.schema.json`; a contract test fails on drift.
 */
export const NIP60_CAPTURE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cashu-fault-lab.dev/schemas/nip60-capture.schema.json',
  title: 'NIP-60 Wallet Doctor Capture',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'capturedAt',
    'digest',
    'subject',
    'observation',
    'rawRelays',
    'redaction',
  ],
  properties: {
    schemaVersion: { const: 1 },
    capturedAt: { type: 'string', maxLength: 64 },
    digest: { type: 'string', pattern: DIGEST },
    subject: { type: 'string', pattern: HEX64 },
    observation: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'relays', 'mint'],
      properties: {
        subject: { type: 'string', pattern: HEX64 },
        relays: {
          type: 'array',
          items: { $ref: '#/$defs/relayObservation' },
          maxItems: 64,
        },
        mint: {
          type: 'array',
          items: { $ref: '#/$defs/mintObservation' },
          maxItems: 1_000_000,
        },
      },
    },
    rawRelays: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'status', 'error', 'events'],
        properties: {
          url: { type: 'string', maxLength: 2048 },
          status: { enum: ['ok', 'error'] },
          error: { type: ['string', 'null'], maxLength: 512 },
          events: {
            type: 'array',
            maxItems: 100_000,
            items: { $ref: '#/$defs/rawEvent' },
          },
        },
      },
    },
    redaction: {
      type: 'object',
      additionalProperties: false,
      required: ['proofSecretsDropped'],
      properties: { proofSecretsDropped: { const: true } },
    },
  },
  $defs: {
    seenOn: {
      type: 'array',
      items: { type: 'string', maxLength: 2048 },
      maxItems: 64,
    },
    proofView: {
      type: 'object',
      additionalProperties: false,
      required: ['keysetId', 'amount', 'y'],
      properties: {
        keysetId: { type: 'string', maxLength: 64 },
        amount: { type: 'integer', minimum: 1, maximum: SAFE_INTEGER },
        y: { type: 'string', pattern: COMPRESSED_POINT },
      },
    },
    tokenEventView: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'createdAt', 'mint', 'unit', 'proofs', 'del', 'seenOn'],
      properties: {
        eventId: { type: 'string', pattern: HEX64 },
        createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        mint: { type: 'string', maxLength: 2048 },
        unit: { type: 'string', maxLength: 16 },
        proofs: { type: 'array', items: { $ref: '#/$defs/proofView' }, maxItems: 100_000 },
        del: {
          type: 'array',
          items: { type: 'string', pattern: HEX64 },
          maxItems: 100_000,
        },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    walletEventView: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'createdAt', 'mints', 'hasP2pkKey', 'seenOn'],
      properties: {
        eventId: { type: 'string', pattern: HEX64 },
        createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        mints: {
          type: 'array',
          items: { type: 'string', maxLength: 2048 },
          minItems: 1,
          maxItems: 1024,
        },
        hasP2pkKey: { type: 'boolean' },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    deletionView: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'createdAt', 'targets', 'kinds', 'seenOn'],
      properties: {
        eventId: { type: 'string', pattern: HEX64 },
        createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        targets: {
          type: 'array',
          items: { type: 'string', pattern: HEX64 },
          maxItems: 100_000,
        },
        kinds: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
          maxItems: 1024,
        },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    historyEventView: {
      type: 'object',
      additionalProperties: false,
      required: [
        'eventId',
        'createdAt',
        'direction',
        'amount',
        'unit',
        'created',
        'destroyed',
        'redeemed',
        'seenOn',
      ],
      properties: {
        eventId: { type: 'string', pattern: HEX64 },
        createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        direction: { enum: ['in', 'out', null] },
        amount: { type: ['integer', 'null'], minimum: 0, maximum: SAFE_INTEGER },
        unit: { type: ['string', 'null'], maxLength: 16 },
        created: { type: 'array', items: { type: 'string', pattern: HEX64 }, maxItems: 100_000 },
        destroyed: { type: 'array', items: { type: 'string', pattern: HEX64 }, maxItems: 100_000 },
        redeemed: { type: 'array', items: { type: 'string', pattern: HEX64 }, maxItems: 100_000 },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    quoteEventView: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'createdAt', 'expiration', 'mint', 'seenOn'],
      properties: {
        eventId: { type: 'string', pattern: HEX64 },
        createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        expiration: { type: ['integer', 'null'], minimum: 0, maximum: SAFE_INTEGER },
        mint: { type: ['string', 'null'], maxLength: 2048 },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    malformedEventView: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'kind', 'reason', 'seenOn'],
      properties: {
        eventId: { type: ['string', 'null'], pattern: HEX64 },
        kind: { type: ['integer', 'null'], minimum: 0, maximum: SAFE_INTEGER },
        reason: {
          enum: [
            'decryption_failed',
            'invalid_payload',
            'invalid_signature',
            'wallet_without_mints',
          ],
        },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    mintObservation: {
      type: 'object',
      additionalProperties: false,
      required: ['mint', 'y', 'state'],
      properties: {
        mint: { type: 'string', maxLength: 2048 },
        y: { type: 'string', pattern: COMPRESSED_POINT },
        state: { enum: ['UNSPENT', 'SPENT', 'PENDING'] },
      },
    },
    relayObservation: {
      type: 'object',
      additionalProperties: false,
      required: [
        'url',
        'status',
        'error',
        'wallet',
        'tokens',
        'deletions',
        'history',
        'quotes',
        'malformed',
      ],
      properties: {
        url: { type: 'string', maxLength: 2048 },
        status: { enum: ['ok', 'error'] },
        error: { type: ['string', 'null'], maxLength: 512 },
        wallet: { type: 'array', items: { $ref: '#/$defs/walletEventView' }, maxItems: 1024 },
        tokens: { type: 'array', items: { $ref: '#/$defs/tokenEventView' }, maxItems: 100_000 },
        deletions: { type: 'array', items: { $ref: '#/$defs/deletionView' }, maxItems: 100_000 },
        history: { type: 'array', items: { $ref: '#/$defs/historyEventView' }, maxItems: 100_000 },
        quotes: { type: 'array', items: { $ref: '#/$defs/quoteEventView' }, maxItems: 100_000 },
        malformed: {
          type: 'array',
          items: { $ref: '#/$defs/malformedEventView' },
          maxItems: 100_000,
        },
      },
    },
    rawEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'],
      properties: {
        id: { type: 'string', pattern: HEX64 },
        pubkey: { type: 'string', pattern: HEX64 },
        created_at: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        kind: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        tags: {
          type: 'array',
          items: { type: 'array', items: { type: 'string', maxLength: 8192 }, maxItems: 1024 },
          maxItems: 4096,
        },
        content: { type: 'string', maxLength: 4_194_304 },
        sig: { type: 'string', pattern: HEX128 },
      },
    },
  },
} as const;

export interface CaptureValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateCapture = ajv.compile(NIP60_CAPTURE_SCHEMA);

function formatErrors(errors: readonly ErrorObject[]): string[] {
  return errors
    .slice(0, 32)
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`);
}

/** Validate an unknown value against the capture bundle contract. */
export function validateNip60Capture(value: unknown): CaptureValidationResult {
  if (validateCapture(value)) return { ok: true, errors: [] };
  return { ok: false, errors: formatErrors(validateCapture.errors ?? []) };
}

export function assertNip60Capture(value: unknown): Nip60Capture {
  const result = validateNip60Capture(value);
  if (!result.ok) {
    throw new Error(`capture bundle is invalid: ${result.errors.join('; ')}`);
  }
  return value as Nip60Capture;
}
