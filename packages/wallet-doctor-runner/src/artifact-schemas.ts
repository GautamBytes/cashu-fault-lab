import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

const HEX64 = '^[0-9a-f]{64}$';
const Y = '^0[23][0-9a-f]{64}$';
const DIGEST = '^sha256:[0-9a-f]{64}$';
const SAFE_INTEGER = 9_007_199_254_740_991;
const CODES = [
  'RELAY_PARTITION',
  'GHOST_TOKEN',
  'ORPHANED_PROOFS',
  'DEL_CHAIN_BREAK',
  'WALLET_EVENT_FORK',
  'DELETION_NOT_PROPAGATED',
  'HISTORY_GAP',
  'QUOTE_LIMBO',
  'MALFORMED_EVENT',
] as const;

const stringList = (pattern?: string) => ({
  type: 'array',
  maxItems: 100_000,
  items: { type: 'string', maxLength: 2048, ...(pattern === undefined ? {} : { pattern }) },
});

export const NIP60_DIAGNOSIS_ARTIFACT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cashu-fault-lab.dev/schemas/nip60-diagnosis.schema.json',
  title: 'NIP-60 Wallet Doctor Diagnosis Artifact',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'kind', 'generatedFrom', 'diagnosis'],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: 'nip60-diagnosis' },
    generatedFrom: { type: 'string', pattern: DIGEST },
    diagnosis: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'findings', 'balance', 'ok'],
      properties: {
        subject: { type: 'string', pattern: HEX64 },
        findings: { type: 'array', maxItems: 100_000, items: { $ref: '#/$defs/finding' } },
        balance: { $ref: '#/$defs/balance' },
        ok: { type: 'boolean' },
      },
    },
  },
  $defs: {
    finding: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'severity', 'summary', 'relays', 'eventIds', 'ys', 'amountAtRisk'],
      properties: {
        code: { enum: CODES },
        severity: { enum: ['error', 'warning', 'info'] },
        summary: { type: 'string', maxLength: 8192 },
        relays: stringList(),
        eventIds: stringList(HEX64),
        ys: stringList(Y),
        mint: { type: 'string', maxLength: 2048 },
        amountAtRisk: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
      },
    },
    relayBalance: {
      type: 'object',
      additionalProperties: false,
      required: ['url', 'status', 'balance'],
      properties: {
        url: { type: 'string', maxLength: 2048 },
        status: { enum: ['ok', 'error'] },
        balance: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
      },
    },
    balance: {
      type: 'object',
      additionalProperties: false,
      required: [
        'perRelay',
        'naiveMerged',
        'merged',
        'mintVerified',
        'doubleCounted',
        'ghost',
        'orphanedUnspent',
      ],
      properties: {
        perRelay: { type: 'array', maxItems: 64, items: { $ref: '#/$defs/relayBalance' } },
        naiveMerged: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        merged: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        mintVerified: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        doubleCounted: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        ghost: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        orphanedUnspent: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
      },
    },
  },
} as const;

export const NIP60_REPAIR_PLAN_ARTIFACT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cashu-fault-lab.dev/schemas/nip60-repair-plan.schema.json',
  title: 'NIP-60 Wallet Doctor Repair Plan Artifact',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'kind', 'generatedFrom', 'plan', 'safety'],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: 'nip60-repair-plan' },
    generatedFrom: { type: 'string', pattern: DIGEST },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'subject', 'captureDigest', 'steps'],
      properties: {
        schemaVersion: { const: 1 },
        subject: { type: 'string', pattern: HEX64 },
        captureDigest: { type: 'string', pattern: DIGEST },
        steps: { type: 'array', maxItems: 100_000, items: { $ref: '#/$defs/step' } },
      },
    },
    safety: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'violations'],
      properties: { ok: { type: 'boolean' }, violations: stringList() },
    },
  },
  $defs: {
    step: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'eventId', 'toRelays'],
          properties: {
            action: { enum: ['republish_event', 'republish_wallet_event'] },
            eventId: { type: 'string' },
            toRelays: stringList(),
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'rolloverId', 'mint', 'unit', 'coveredYs', 'del', 'toRelays'],
          properties: {
            action: { const: 'publish_rollover' },
            rolloverId: { type: 'string', maxLength: 256 },
            mint: { type: 'string', maxLength: 2048 },
            unit: { type: 'string', maxLength: 16 },
            coveredYs: stringList(Y),
            del: stringList(HEX64),
            toRelays: stringList(),
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'eventIds', 'toRelays'],
          properties: {
            action: { const: 'delete_events' },
            eventIds: stringList(HEX64),
            toRelays: stringList(),
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'kind', 'mint', 'ys'],
          properties: {
            action: { const: 'wallet_action' },
            kind: { const: 'nut09_restore' },
            mint: { type: 'string', maxLength: 2048 },
            ys: stringList(Y),
          },
        },
      ],
    },
  },
} as const;

export const NIP60_CHECK_ARTIFACT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cashu-fault-lab.dev/schemas/nip60-check.schema.json',
  title: 'NIP-60 Wallet Doctor Check Artifact',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'kind',
    'generatedFrom',
    'ok',
    'summary',
    'liveVerification',
    'diagnosis',
    'plan',
  ],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: 'nip60-check' },
    generatedFrom: { type: ['string', 'null'], pattern: DIGEST },
    ok: { type: 'boolean' },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'errorFindings',
        'warningFindings',
        'infoFindings',
        'failedRelays',
        'codes',
        'mintVerified',
        'merged',
        'doubleCounted',
        'integrityErrors',
      ],
      properties: {
        errorFindings: { type: 'integer', minimum: 0 },
        warningFindings: { type: 'integer', minimum: 0 },
        infoFindings: { type: 'integer', minimum: 0 },
        failedRelays: { type: 'integer', minimum: 0 },
        codes: { type: 'array', uniqueItems: true, items: { enum: CODES } },
        mintVerified: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        merged: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        doubleCounted: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        integrityErrors: stringList(),
      },
    },
    liveVerification: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'errors'],
      properties: { ok: { type: 'boolean' }, errors: stringList() },
    },
    diagnosis: {
      oneOf: [{ type: 'null' }, { $ref: NIP60_DIAGNOSIS_ARTIFACT_SCHEMA.$id }],
    },
    plan: { oneOf: [{ type: 'null' }, { $ref: NIP60_REPAIR_PLAN_ARTIFACT_SCHEMA.$id }] },
  },
} as const;

export interface ArtifactValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const artifactAjv = new Ajv2020({ allErrors: true, strict: true });
artifactAjv.addSchema(NIP60_DIAGNOSIS_ARTIFACT_SCHEMA);
artifactAjv.addSchema(NIP60_REPAIR_PLAN_ARTIFACT_SCHEMA);
artifactAjv.addSchema(NIP60_CHECK_ARTIFACT_SCHEMA);

function resultFor(
  valid: boolean,
  errors: readonly ErrorObject[] | null | undefined,
): ArtifactValidationResult {
  return {
    ok: valid,
    errors: valid
      ? []
      : (errors ?? [])
          .slice(0, 32)
          .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`),
  };
}

function validateById(schemaId: string, value: unknown): ArtifactValidationResult {
  const validator = artifactAjv.getSchema(schemaId);
  if (validator === undefined) throw new Error(`artifact schema ${schemaId} is not registered`);
  return resultFor(Boolean(validator(value)), validator.errors);
}

export const validateNip60DiagnosisArtifact = (value: unknown): ArtifactValidationResult =>
  validateById(NIP60_DIAGNOSIS_ARTIFACT_SCHEMA.$id, value);

export const validateNip60RepairPlanArtifact = (value: unknown): ArtifactValidationResult =>
  validateById(NIP60_REPAIR_PLAN_ARTIFACT_SCHEMA.$id, value);

export const validateNip60CheckArtifact = (value: unknown): ArtifactValidationResult =>
  validateById(NIP60_CHECK_ARTIFACT_SCHEMA.$id, value);
