import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

const operationId = { type: 'string', pattern: '^[A-Za-z0-9_-]{21}[AQgw]$' } as const;
const mint = { type: 'string', format: 'uri', maxLength: 2_048 } as const;
const unit = { type: 'string', pattern: '^[a-z0-9_-]{1,16}$' } as const;
const amount = { type: 'integer', minimum: 1, maximum: 9_007_199_254_740_991 } as const;

function operationInput(
  kind: string,
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['operationId', 'kind', 'mint', 'unit', ...required],
    properties: { operationId, kind: { const: kind }, mint, unit, ...properties },
  };
}

export const lifecycleScenarioSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cashu-fault-lab.dev/schema/lifecycle-scenario-v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'id', 'seed', 'requiredOperations', 'commands'],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
    description: { type: 'string', minLength: 1, maxLength: 1_024 },
    seed: { type: 'string', minLength: 1, maxLength: 256 },
    requireQuiescence: { type: 'boolean' },
    requiredOperations: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: ['mint', 'swap', 'send', 'receive', 'melt', 'restore', 'reconcile'] },
    },
    commands: {
      type: 'array',
      minItems: 1,
      maxItems: 1_000,
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'rule'],
            properties: {
              type: { const: 'fault' },
              rule: {
                type: 'object',
                additionalProperties: false,
                required: ['action', 'endpoint', 'occurrence'],
                properties: {
                  action: {
                    enum: [
                      'drop_request',
                      'drop_response',
                      'delay_request',
                      'delay_response',
                      'duplicate_request',
                      'reset_connection',
                      'stale_response',
                      'truncate_response',
                    ],
                  },
                  endpoint: {
                    enum: ['mint', 'swap', 'melt', 'quote', 'proof_state', 'restore'],
                  },
                  occurrence: { type: 'integer', minimum: 1, maximum: 1_000_000 },
                  delayMs: { type: 'integer', minimum: 0, maximum: 300_000 },
                  truncateBytes: { type: 'integer', minimum: 0, maximum: 65_536 },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type'],
            properties: { type: { const: 'clear_faults' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'input'],
            properties: {
              type: { const: 'start' },
              input: {
                oneOf: [
                  operationInput('mint', ['amount', 'method'], {
                    amount,
                    method: { const: 'bolt11' },
                  }),
                  operationInput('swap', ['amount'], { amount }),
                  operationInput('send', ['amount', 'recipient'], {
                    amount,
                    recipient: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{0,63}$' },
                  }),
                  operationInput('receive', ['token'], {
                    token: { type: 'string', minLength: 1, maxLength: 262_144 },
                  }),
                  operationInput('melt', ['invoice'], {
                    invoice: { type: 'string', minLength: 1, maxLength: 16_384 },
                    preferAsync: { type: 'boolean' },
                  }),
                  operationInput('restore', [], {}),
                  operationInput('reconcile', ['targetOperationId'], {
                    targetOperationId: operationId,
                  }),
                ],
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'operationId'],
            properties: { type: { const: 'resume' }, operationId },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'component'],
            properties: { type: { const: 'restart' }, component: { enum: ['adapter', 'mint'] } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'operationId', 'count'],
            properties: {
              type: { const: 'resume_concurrently' },
              operationId,
              count: { type: 'integer', minimum: 2, maximum: 32 },
            },
          },
        ],
      },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat('uri', {
  type: 'string',
  validate(value: string): boolean {
    try {
      const parsed = new URL(value);
      return (
        ['http:', 'https:'].includes(parsed.protocol) &&
        parsed.username === '' &&
        parsed.password === ''
      );
    } catch {
      return false;
    }
  },
});
const validator = ajv.compile(lifecycleScenarioSchema);

export type LifecycleScenarioValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly path: string; readonly message: string };

function preferredError(errors: readonly ErrorObject[]): ErrorObject {
  return (
    errors.find((error) => error.keyword === 'additionalProperties') ??
    errors.find((error) => error.keyword === 'required') ??
    errors[0]!
  );
}

export function validateLifecycleScenarioSpec(value: unknown): LifecycleScenarioValidationResult {
  if (validator(value)) return { ok: true };
  const error = preferredError(validator.errors ?? []);
  return {
    ok: false,
    path: error.instancePath,
    message: error.message ?? 'Lifecycle scenario validation failed',
  };
}
