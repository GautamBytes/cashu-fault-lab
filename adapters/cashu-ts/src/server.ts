import {
  PaymentRequest,
  PaymentRequestTransportType,
  type PaymentRequestTransport,
} from '@cashu/cashu-ts';
import {
  AdapterNotApplicableError,
  validateAdapterRequest,
  validateAdapterResponse,
  type AdapterCapabilities,
  type CreateRequestInput,
  type DeliveryReceiptView,
  type LedgerCreditView,
  type PaymentRequestView,
  type ProofEvidenceView,
  type SendPaymentInput,
} from '@cashu-fault-lab/adapter-contract';
import { parseProtocolId } from '@cashu-fault-lab/delivery-core';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';

const capabilities: AdapterCapabilities = {
  implementation: 'cashu-ts',
  version: '4.7.2',
  nuts: [18, 26],
  transports: ['http', 'nostr'],
  evidenceTier: 'T0',
  encodings: ['creqA', 'creqB'],
  profiles: [
    { name: 'legacy-nut18', roles: ['sender', 'receiver'], status: 'supported' },
    {
      name: 'delivery-v1',
      roles: ['sender', 'receiver'],
      status: 'unsupported',
      reason: 'cashu-ts does not implement the experimental receipt/idempotency profile',
    },
    {
      name: 'nut26-nostr',
      roles: ['sender', 'receiver'],
      status: 'supported',
    },
  ],
};

export interface CashuTsAdapterOperations {
  capabilities?(): Promise<AdapterCapabilities>;
  reset?(seed: string): Promise<void>;
  send(input: SendPaymentInput): Promise<DeliveryReceiptView>;
  delivery(deliveryId: string): Promise<DeliveryReceiptView>;
  ledger(): Promise<readonly LedgerCreditView[]>;
  proofs(): Promise<readonly ProofEvidenceView[]>;
}

export interface CashuTsAdapterServerOptions {
  readonly now: () => number;
  readonly httpTarget?: string;
  readonly nostrTarget?: string;
  readonly mints?: readonly string[];
  readonly operations?: CashuTsAdapterOperations;
  readonly controlToken?: string;
  readonly testMode?: boolean;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
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

function assertResponse(
  operation: Parameters<typeof validateAdapterResponse>[0],
  value: unknown,
): void {
  const result = validateAdapterResponse(operation, value);
  if (!result.ok) throw new Error(`cashu-ts adapter response violates ${operation} contract`);
}

function unavailable(reply: FastifyReply, reason: string): FastifyReply {
  return reply.code(501).send({ status: 'N/A', reason });
}

function notApplicableReason(error: unknown): string | undefined {
  if (error instanceof AdapterNotApplicableError) return error.reason;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return undefined;
  const value = error as Readonly<Record<string, unknown>>;
  return value.code === 'ADAPTER_NOT_APPLICABLE' && typeof value.reason === 'string'
    ? value.reason
    : undefined;
}

async function invoke<T>(
  reply: FastifyReply,
  operation: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const reason = notApplicableReason(error);
    if (reason !== undefined) {
      unavailable(reply, reason);
      return { ok: false };
    }
    throw error;
  }
}

function protocolId(seed: string, ordinal: number): string {
  return createHash('sha256')
    .update('cashu-fault-lab/cashu-ts-adapter-id-v1\0')
    .update(seed)
    .update('\0')
    .update(String(ordinal))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

function transportViews(
  input: CreateRequestInput,
  options: CashuTsAdapterServerOptions,
): readonly PaymentRequestTransport[] {
  return input.transports.map((transport): PaymentRequestTransport => {
    if (transport === 'http') {
      if (!options.httpTarget) throw new Error('HTTP request target is not configured');
      return { type: PaymentRequestTransportType.POST, target: options.httpTarget };
    }
    if (!options.nostrTarget) throw new Error('Nostr request target is not configured');
    return {
      type: PaymentRequestTransportType.NOSTR,
      target: options.nostrTarget,
      tags: [['n', '17']],
    };
  });
}

export async function buildCashuTsAdapterServer(
  options: CashuTsAdapterServerOptions,
): Promise<FastifyInstance> {
  if (!options.testMode && !options.controlToken) {
    throw new Error('A control token is required outside explicit test mode');
  }
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  let seed: string | undefined;
  let requestOrdinal = 0;

  app.addHook('preHandler', async (request, reply) => {
    if (options.testMode) return;
    if (!secureEqual(request.headers.authorization ?? '', `Bearer ${options.controlToken!}`)) {
      await reply.code(401).header('WWW-Authenticate', 'Bearer').send({
        code: 'UNAUTHORIZED',
        message: 'A valid adapter control token is required',
      });
    }
  });

  app.get('/v1/capabilities', async () => {
    const value = (await options.operations?.capabilities?.()) ?? capabilities;
    assertResponse('capabilities', value);
    return value;
  });

  app.post<{ Body: unknown }>('/v1/reset', async (request, reply) => {
    if (!validateRequest('reset', request.body, reply)) return reply;
    seed = (request.body as { readonly seed: string }).seed;
    requestOrdinal = 0;
    await options.operations?.reset?.(seed);
    const response = { ok: true } as const;
    assertResponse('reset', response);
    return response;
  });

  app.post<{ Body: unknown }>('/v1/requests', async (request, reply) => {
    if (!validateRequest('createRequest', request.body, reply)) return reply;
    if (!seed) return reply.code(409).send({ code: 'RESET_REQUIRED', message: 'Reset first' });
    const input = request.body as CreateRequestInput;
    let transports: readonly PaymentRequestTransport[];
    try {
      transports = transportViews(input, options);
    } catch (error) {
      return reply.code(422).send({
        code: 'TRANSPORT_NOT_CONFIGURED',
        message: error instanceof Error ? error.message : 'Transport is unavailable',
      });
    }
    const id = protocolId(seed, requestOrdinal);
    requestOrdinal += 1;
    const paymentRequest = new PaymentRequest(
      [...transports],
      id,
      input.amount,
      input.unit,
      options.mints ? [...options.mints] : [],
      input.description,
      input.singleUse,
    );
    const now = options.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Adapter time is invalid');
    const value: PaymentRequestView = {
      id,
      raw: paymentRequest.toEncodedCreqA(),
      amount: input.amount,
      unit: input.unit,
      singleUse: input.singleUse,
      expiresAt: now + input.expiresIn,
      transports: transports.map((transport) => ({
        type: transport.type,
        target: transport.target,
        ...(transport.tags === undefined ? {} : { tags: transport.tags }),
      })),
    };
    assertResponse('createRequest', value);
    return value;
  });

  app.post<{ Body: unknown }>('/v1/send', async (request, reply) => {
    if (!validateRequest('send', request.body, reply)) return reply;
    if (!options.operations) {
      return unavailable(reply, 'No funded cashu-ts wallet operations were configured');
    }
    const result = await invoke(reply, () =>
      options.operations!.send(request.body as SendPaymentInput),
    );
    if (!result.ok) return reply;
    const value = result.value;
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
    if (!options.operations)
      return unavailable(reply, 'Delivery state operations are not configured');
    const result = await invoke(reply, () => options.operations!.delivery(request.params.id));
    if (!result.ok) return reply;
    const value = result.value;
    assertResponse('delivery', value);
    return value;
  });

  app.get('/v1/ledger', async (_request, reply) => {
    if (!options.operations)
      return unavailable(reply, 'Receiver ledger operations are not configured');
    const result = await invoke(reply, () => options.operations!.ledger());
    if (!result.ok) return reply;
    const value = result.value;
    assertResponse('ledger', value);
    return value;
  });

  app.get('/v1/proofs', async (_request, reply) => {
    if (!options.operations)
      return unavailable(reply, 'Proof evidence operations are not configured');
    const result = await invoke(reply, () => options.operations!.proofs());
    if (!result.ok) return reply;
    const value = result.value;
    assertResponse('proofs', value);
    return value;
  });

  return app;
}
