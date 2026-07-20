import type {
  AdapterCapabilities,
  CreateRequestInput,
  DeliveryReceiptView,
  LedgerCreditView,
  PaymentRequestView,
  ProofEvidenceView,
  SendPaymentInput,
} from '@cashu-fault-lab/adapter-contract';
import Fastify, { type FastifyInstance } from 'fastify';

const UNAUTH = { statusCode: 401, error: 'Unauthorized' } as const;

interface AdapterServerOptions {
  token: string;
}

export function createAdapterServer(options: AdapterServerOptions): FastifyInstance {
  const { token } = options;
  const server = Fastify({ logger: false });

  server.addHook('onRequest', async (request, reply) => {
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      await reply.status(401).send(UNAUTH);
    }
  });

  // GET /v1/capabilities — Declare implementation identity and supported profiles.
  server.get('/v1/capabilities', async (_request, reply) => {
    const capabilities: AdapterCapabilities = {
      implementation: 'template',
      version: '0.0.0',
      nuts: [18],
      transports: ['http'],
      evidenceTier: 'T0',
      encodings: ['creqA'],
      profiles: [
        {
          name: 'delivery-v1',
          roles: ['sender'],
          status: 'unsupported',
          reason: 'Replace with your real wallet implementation',
        },
      ],
    };
    return reply.send(capabilities);
  });

  // POST /v1/reset — Reset deterministic test state from a seed.
  server.post('/v1/reset', async (_request, reply) => {
    // TODO: Provision deterministic test state from the seed.
    // Use a pinned fake-wallet mint for T0/T1 testing.
    return reply.status(501).send({ status: 'N/A', reason: 'reset not implemented' });
  });

  // POST /v1/requests — Create a payment request (receiver role).
  server.post('/v1/requests', async (_request, reply) => {
    // TODO: Create a NUT-18 payment request.
    return reply.status(501).send({ status: 'N/A', reason: 'createRequest not implemented' });
  });

  // POST /v1/send — Send or resume one logical payment (sender role).
  server.post('/v1/send', async (_request, reply) => {
    // TODO: Reserve proofs, construct delivery payload, send through transport.
    // If called again with the same deliveryId, reuse exact inner payload bytes.
    return reply.status(501).send({ status: 'N/A', reason: 'send not implemented' });
  });

  // GET /v1/deliveries/:id — Read the current receipt for a delivery (receiver role).
  server.get('/v1/deliveries/:id', async (_request, reply) => {
    return reply.status(501).send({ status: 'N/A', reason: 'delivery not implemented' });
  });

  // GET /v1/ledger — Return merchant credit evidence (receiver role).
  server.get('/v1/ledger', async (_request, reply) => {
    return reply.status(501).send({ status: 'N/A', reason: 'ledger not implemented' });
  });

  // GET /v1/proofs — Return proof-state hashes without secrets.
  server.get('/v1/proofs', async (_request, reply) => {
    return reply.status(501).send({ status: 'N/A', reason: 'proofs not implemented' });
  });

  return server;
}
