import {
  validateAdapterRequest,
  validateAdapterResponse,
  type AdapterCapabilities,
  type SendPaymentInput,
} from '@cashu-fault-lab/adapter-contract';
import { parseProtocolId, type DeliveryReceiptWire } from '@cashu-fault-lab/delivery-core';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

export interface SenderAdapterControl {
  capabilities(): Promise<AdapterCapabilities>;
  reset(seed: string): Promise<void>;
  send(input: SendPaymentInput): Promise<DeliveryReceiptWire>;
  delivery(deliveryId: string): Promise<DeliveryReceiptWire>;
}

export interface SenderAdapterServerOptions {
  readonly control: SenderAdapterControl;
  readonly controlToken?: string;
  readonly testMode?: boolean;
}

import { secureEqual } from '@cashu-fault-lab/delivery-core';

function assertResponse(
  operation: Parameters<typeof validateAdapterResponse>[0],
  value: unknown,
): void {
  const result = validateAdapterResponse(operation, value);
  if (!result.ok) {
    throw new Error(`Adapter ${operation} response violates contract: ${result.errorCode}`);
  }
}

function validateRequest(
  operation: Parameters<typeof validateAdapterRequest>[0],
  value: unknown,
  reply: FastifyReply,
): boolean {
  const result = validateAdapterRequest(operation, value);
  if (result.ok) return true;
  void reply.code(422).send({ code: result.errorCode, path: result.path, message: result.message });
  return false;
}

export async function buildSenderAdapterServer(
  options: SenderAdapterServerOptions,
): Promise<FastifyInstance> {
  if (!options.testMode && !options.controlToken) {
    throw new Error('A control token is required outside explicit test mode');
  }
  const app = Fastify({ logger: false, bodyLimit: 16_384 });

  app.addHook('preHandler', async (request, reply) => {
    if (options.testMode) return;
    const expected = `Bearer ${options.controlToken!}`;
    if (!secureEqual(request.headers.authorization ?? '', expected)) {
      await reply.code(401).header('WWW-Authenticate', 'Bearer').send({
        code: 'UNAUTHORIZED',
        message: 'A valid adapter control token is required',
      });
    }
  });

  app.get('/v1/capabilities', async () => {
    const value = await options.control.capabilities();
    assertResponse('capabilities', value);
    return value;
  });
  app.post<{ Body: unknown }>('/v1/reset', async (request, reply) => {
    if (!validateRequest('reset', request.body, reply)) return reply;
    const input = request.body as { readonly seed: string };
    await options.control.reset(input.seed);
    const value = { ok: true } as const;
    assertResponse('reset', value);
    return value;
  });
  app.post<{ Body: unknown }>('/v1/send', async (request, reply) => {
    if (!validateRequest('send', request.body, reply)) return reply;
    const value = await options.control.send(request.body as SendPaymentInput);
    assertResponse('send', value);
    return value;
  });
  app.get<{ Params: { id: string } }>('/v1/deliveries/:id', async (request, reply) => {
    try {
      parseProtocolId(request.params.id);
    } catch {
      return reply
        .code(422)
        .send({ code: 'INVALID_PROTOCOL_ID', message: 'Delivery ID is invalid' });
    }
    const value = await options.control.delivery(request.params.id);
    assertResponse('delivery', value);
    return value;
  });

  return app;
}
