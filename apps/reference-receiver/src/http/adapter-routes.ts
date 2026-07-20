import {
  validateAdapterRequest,
  validateAdapterResponse,
  type AdapterCapabilities,
  type CreateRequestInput,
  type LedgerCreditView,
  type PaymentRequestView,
  type ProofEvidenceView,
} from '@cashu-fault-lab/adapter-contract';
import { parseProtocolId, type DeliveryReceiptWire } from '@cashu-fault-lab/delivery-core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { TextDecoder } from 'node:util';

const CONTROL_BODY_LIMIT = 16_384;

export interface ReceiverAdapterControl {
  capabilities(): Promise<AdapterCapabilities>;
  reset(seed: string): Promise<void>;
  createRequest(input: CreateRequestInput): Promise<PaymentRequestView>;
  delivery(deliveryId: string): Promise<DeliveryReceiptWire>;
  ledger(): Promise<readonly LedgerCreditView[]>;
  proofs(): Promise<readonly ProofEvidenceView[]>;
}

export interface ReceiverAdapterRouteOptions {
  readonly control: ReceiverAdapterControl;
  readonly controlToken?: string;
  readonly testMode?: boolean;
}

import { secureEqual } from '@cashu-fault-lab/delivery-core';

function decodeBody(body: unknown, reply: FastifyReply): unknown {
  if (!Buffer.isBuffer(body)) return body;
  if (body.byteLength > CONTROL_BODY_LIMIT) {
    void reply.code(413).send({
      code: 'CONTROL_PAYLOAD_TOO_LARGE',
      message: `Adapter control body exceeds ${CONTROL_BODY_LIMIT.toLocaleString('en-US')} bytes`,
    });
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    void reply
      .code(400)
      .send({ code: 'INVALID_JSON', message: 'Adapter control body is invalid JSON' });
    return undefined;
  }
}

function validateRequest(
  operation: Parameters<typeof validateAdapterRequest>[0],
  body: unknown,
  reply: FastifyReply,
): unknown {
  const value = decodeBody(body, reply);
  if (reply.sent) return undefined;
  const result = validateAdapterRequest(operation, value);
  if (result.ok) return value;
  void reply.code(422).send({ code: result.errorCode, path: result.path, message: result.message });
  return undefined;
}

function assertResponse(
  operation: Parameters<typeof validateAdapterResponse>[0],
  value: unknown,
): void {
  const result = validateAdapterResponse(operation, value);
  if (!result.ok) {
    throw new Error(`Adapter ${operation} response violates contract: ${result.errorCode}`);
  }
}

export function registerReceiverAdapterRoutes(
  app: FastifyInstance,
  options: ReceiverAdapterRouteOptions,
): void {
  if (!options.testMode && !options.controlToken) {
    throw new Error('A control token is required outside explicit test mode');
  }

  app.register(
    async (controlApp) => {
      controlApp.addHook('preHandler', async (request, reply) => {
        if (options.testMode) return;
        const expected = `Bearer ${options.controlToken!}`;
        if (!secureEqual(request.headers.authorization ?? '', expected)) {
          await reply.code(401).header('WWW-Authenticate', 'Bearer').send({
            code: 'UNAUTHORIZED',
            message: 'A valid adapter control token is required',
          });
        }
      });

      controlApp.get('/capabilities', async () => {
        const value = await options.control.capabilities();
        assertResponse('capabilities', value);
        return value;
      });
      controlApp.post<{ Body: unknown }>('/reset', async (request, reply) => {
        const input = validateRequest('reset', request.body, reply) as
          { readonly seed: string } | undefined;
        if (!input) return reply;
        await options.control.reset(input.seed);
        const value = { ok: true } as const;
        assertResponse('reset', value);
        return value;
      });
      controlApp.post<{ Body: unknown }>('/requests', async (request, reply) => {
        const input = validateRequest('createRequest', request.body, reply) as
          CreateRequestInput | undefined;
        if (!input) return reply;
        const value = await options.control.createRequest(input);
        assertResponse('createRequest', value);
        return value;
      });
      controlApp.get<{ Params: { id: string } }>('/deliveries/:id', async (request, reply) => {
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
      controlApp.get('/ledger', async () => {
        const value = await options.control.ledger();
        assertResponse('ledger', value);
        return value;
      });
      controlApp.get('/proofs', async () => {
        const value = await options.control.proofs();
        assertResponse('proofs', value);
        return value;
      });
    },
    { prefix: '/v1' },
  );
}
