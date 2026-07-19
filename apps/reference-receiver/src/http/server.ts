import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { AcceptDeliveryDependencies } from '../domain/accept-delivery.js';
import {
  registerReceiverAdapterRoutes,
  type ReceiverAdapterRouteOptions,
} from './adapter-routes.js';
import { PAYMENT_BODY_LIMIT, registerPaymentRoute } from './payment-route.js';

export interface ReceiverHttpServerOptions {
  readonly accept: AcceptDeliveryDependencies;
  readonly corsOrigins?: readonly string[];
  readonly adapter?: ReceiverAdapterRouteOptions;
}

function isBodyTooLarge(error: FastifyError): boolean {
  return error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 413;
}

export async function buildReceiverHttpServer(
  options: ReceiverHttpServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: PAYMENT_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (isBodyTooLarge(error)) {
      return reply.code(413).send({
        code: 'PAYLOAD_TOO_LARGE',
        message: `Payment payload exceeds ${PAYMENT_BODY_LIMIT.toLocaleString('en-US')} bytes`,
      });
    }
    if (error.statusCode === 415) {
      return reply.code(415).send({
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Payment requests require application/json',
      });
    }
    return reply.code(error.statusCode ?? 500).send({
      code: error.code || 'INTERNAL_ERROR',
      message: error.statusCode && error.statusCode < 500 ? error.message : 'Internal server error',
    });
  });

  await app.register(cors, {
    origin: options.corsOrigins ? [...options.corsOrigins] : false,
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
  });
  registerPaymentRoute(app, options.accept);
  if (options.adapter) registerReceiverAdapterRoutes(app, options.adapter);
  return app;
}
