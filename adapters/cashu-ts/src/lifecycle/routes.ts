import {
  validateLifecycleRequest,
  validateLifecycleResponse,
  type LifecycleAdapterClient,
  type LifecycleOperationInput,
  type LifecycleRequestOperation,
  type LifecycleResponseOperation,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import { parseOperationId } from '@cashu-fault-lab/wallet-lifecycle-core';
import type { FastifyInstance, FastifyReply } from 'fastify';

function validateRequest(
  operation: LifecycleRequestOperation,
  value: unknown,
  reply: FastifyReply,
): boolean {
  const result = validateLifecycleRequest(operation, value);
  if (result.ok) return true;
  void reply.code(422).send({ code: result.errorCode, path: result.path, message: result.message });
  return false;
}

function assertResponse(operation: LifecycleResponseOperation, value: unknown): void {
  const result = validateLifecycleResponse(operation, value);
  if (!result.ok) throw new Error(`cashu-ts lifecycle response violates ${operation} contract`);
}

function operationId(value: string): string {
  try {
    return parseOperationId(value);
  } catch {
    throw Object.assign(new Error('Lifecycle operation ID is invalid'), {
      statusCode: 422,
      code: 'INVALID_LIFECYCLE_OPERATION_ID',
    });
  }
}

export function registerCashuTsLifecycleRoutes(
  app: FastifyInstance,
  lifecycle: LifecycleAdapterClient,
): void {
  app.get('/v1/lifecycle/capabilities', async () => {
    const value = await lifecycle.capabilities();
    assertResponse('capabilities', value);
    return value;
  });

  app.post<{ Body: unknown }>('/v1/lifecycle/reset', async (request, reply) => {
    if (!validateRequest('reset', request.body, reply)) return reply;
    await lifecycle.reset((request.body as { readonly seed: string }).seed);
    const value = { ok: true } as const;
    assertResponse('reset', value);
    return value;
  });

  app.post<{ Body: unknown }>(
    '/v1/lifecycle/operations',
    { bodyLimit: 300_000 },
    async (request, reply) => {
      if (!validateRequest('start', request.body, reply)) return reply;
      const value = await lifecycle.start(request.body as LifecycleOperationInput);
      assertResponse('start', value);
      return value;
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/lifecycle/operations/:id/resume',
    async (request, reply) => {
      if (!validateRequest('resume', request.body, reply)) return reply;
      const selected = operationId(request.params.id);
      if ((request.body as { readonly operationId: string }).operationId !== selected) {
        return reply.code(409).send({
          code: 'LIFECYCLE_OPERATION_ID_CONFLICT',
          message: 'Lifecycle operation identity conflicts',
        });
      }
      const value = await lifecycle.resume(selected);
      assertResponse('resume', value);
      return value;
    },
  );

  app.get<{ Params: { id: string } }>('/v1/lifecycle/operations/:id', async (request) => {
    const value = await lifecycle.operation(operationId(request.params.id));
    assertResponse('operation', value);
    return value;
  });

  app.get('/v1/lifecycle/wallet', async () => {
    const value = await lifecycle.wallet();
    assertResponse('wallet', value);
    return value;
  });

  app.get('/v1/lifecycle/evidence', async () => {
    const value = await lifecycle.evidence();
    assertResponse('evidence', value);
    return value;
  });
}
