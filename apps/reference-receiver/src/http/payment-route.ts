import { DeliveryValidationError, serializeDeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AcceptDeliveryDependencies } from '../domain/accept-delivery.js';
import { acceptPayloadBytes } from '../domain/accept-payload.js';
import { ReceiverDomainError, type ReceiverErrorCode } from '../domain/types.js';

export const PAYMENT_BODY_LIMIT = 65_536;

interface ErrorBody {
  readonly code: string;
  readonly message: string;
}

const CONFLICT_CODES = new Set<ReceiverErrorCode>([
  'DELIVERY_CONFLICT',
  'PROOF_CONFLICT',
  'SINGLE_USE_CONFLICT',
]);
const EXPIRED_CODES = new Set<ReceiverErrorCode>(['REQUEST_EXPIRED', 'DELIVERY_EXPIRED']);

function sendError(reply: FastifyReply, statusCode: number, body: ErrorBody): void {
  void reply.code(statusCode).type('application/json').send(body);
}

function mapPaymentError(error: unknown, reply: FastifyReply): void {
  if (error instanceof ReceiverDomainError) {
    const statusCode = CONFLICT_CODES.has(error.code)
      ? 409
      : EXPIRED_CODES.has(error.code)
        ? 410
        : 422;
    sendError(reply, statusCode, { code: error.code, message: error.message });
    return;
  }
  if (error instanceof DeliveryValidationError) {
    sendError(reply, error.code === 'DELIVERY_EXPIRED' ? 410 : 422, {
      code: error.code,
      message: error.message,
    });
    return;
  }
  throw error;
}

export function registerPaymentRoute(
  app: FastifyInstance,
  dependencies: AcceptDeliveryDependencies,
): void {
  app.post<{ Body: Buffer }>('/pay', async (request, reply) => {
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
        return reply.code(415).send({
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Payment requests require application/json',
        });
      }
      const receipt = await acceptPayloadBytes(request.body, dependencies);
      if (receipt.status === 'processing') {
        reply.header('Retry-After', '1').code(202);
      } else {
        reply.code(200);
      }
      return serializeDeliveryReceipt(receipt);
    } catch (error) {
      mapPaymentError(error, reply);
      return reply;
    }
  });
}
