import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import {
  computePayloadHash,
  parseDeliveryPayloadJson,
  parseProtocolId,
  serializeDeliveryPayload,
  type CashuProof,
  type DeliveryPayload,
} from '@cashu-fault-lab/delivery-core';
import {
  MemoryReceiverStore,
  type MintGateway,
  type ProofVerifier,
  type SwapPlanDraft,
} from '@cashu-fault-lab/reference-receiver';
import { describe, expect, it } from 'vitest';
import {
  FundedCashuTsDualRoleOperations,
  FundedCashuTsReceiverOperations,
} from '../src/funded-receiver-operations.js';
import { buildCashuTsAdapterServer } from '../src/server.js';
import type { CashuTsTransportPort, CashuTsWalletPort } from '../src/funded-operations.js';

const now = 1_784_399_400;
const mintUrl = 'https://mint.example';
const paymentTarget = 'http://127.0.0.1:4101/pay';
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const proofY = `02${'01'.repeat(32)}`;
const proof: CashuProof = {
  amount: 8,
  id: '00aa',
  secret: 'receiver-proof-secret',
  C: `02${'11'.repeat(32)}`,
};

class FakeVerifier implements ProofVerifier {
  async inspect(): Promise<Awaited<ReturnType<ProofVerifier['inspect']>>> {
    return {
      ys: [proofY],
      proofClaimIds: ['claim-1'],
      proofSetHash: 'b'.repeat(64),
      netAmount: 8,
    };
  }
}

class FakeMint implements MintGateway {
  prepareCalls = 0;
  swapCalls = 0;

  async prepareSwap(
    draft: SwapPlanDraft,
  ): Promise<Awaited<ReturnType<MintGateway['prepareSwap']>>> {
    this.prepareCalls += 1;
    return {
      ...draft,
      serializedRequest: '{"swap":true}',
      keysetId: '00aa',
      inputFeePpk: 0,
      outputs: [{ amount: 8, id: '00aa', B_: 'B', secret: 's', blindingFactor: '0'.repeat(64) }],
      preparedAt: now,
      recovery: { nut09: true, nut19Replay: true, nut19ReplayUntil: null },
    };
  }

  async swap(): Promise<Awaited<ReturnType<MintGateway['swap']>>> {
    this.swapCalls += 1;
    return { replacementPlanHash: 'c'.repeat(64), replacementProofs: ['replacement-proof'] };
  }

  async restore(): Promise<Awaited<ReturnType<MintGateway['restore']>>> {
    return { kind: 'not_found' };
  }

  async proofStates(): Promise<Awaited<ReturnType<MintGateway['proofStates']>>> {
    return ['SPENT'];
  }
}

class SenderWallet implements CashuTsWalletPort {
  async reset(): Promise<void> {}

  async reserve(): Promise<Awaited<ReturnType<CashuTsWalletPort['reserve']>>> {
    return { mint: mintUrl, proofs: [proof] };
  }

  async markSettled(): Promise<void> {}

  async evidence(
    selectedDeliveryId: string,
  ): Promise<Awaited<ReturnType<CashuTsWalletPort['evidence']>>> {
    return {
      deliveryId: selectedDeliveryId,
      proofSetHash: 'd'.repeat(64),
      inputYs: [proofY],
      state: 'spent',
    };
  }
}

function payload(id = requestId): DeliveryPayload {
  return {
    id: parseProtocolId(id),
    memo: null,
    mint: mintUrl,
    unit: 'sat',
    proofs: [proof],
    delivery: {
      version: 1,
      id: parseProtocolId(deliveryId),
      createdAt: now,
      expiresAt: now + 900,
    },
  };
}

function settledReceipt(payloadBytes: Uint8Array) {
  const parsed = parseDeliveryPayloadJson(payloadBytes, now);
  return {
    profile: 'cashu-delivery-v1' as const,
    request_id: parsed.id,
    delivery_id: parsed.delivery.id,
    payload_hash: computePayloadHash({
      requestId: parsed.id,
      memo: parsed.memo,
      mint: parsed.mint,
      unit: parsed.unit,
      proofs: parsed.proofs,
      createdAt: parsed.delivery.createdAt,
      expiresAt: parsed.delivery.expiresAt,
    }),
    status: 'settled' as const,
    status_version: 2,
    mint: parsed.mint,
    unit: parsed.unit,
    amount: parsed.proofs.reduce((sum, candidate) => sum + candidate.amount, 0),
    detail_code: 'settled',
  };
}

function receiverFixture() {
  const store = new MemoryReceiverStore();
  const mint = new FakeMint();
  const receiver = new FundedCashuTsReceiverOperations({
    store,
    mintUrl,
    paymentTarget,
    mint,
    verifier: new FakeVerifier(),
    now: () => now,
  });
  return { mint, receiver };
}

describe('FundedCashuTsReceiverOperations', () => {
  it('settles a delivery-v1 payload and exposes one credit plus spent proof evidence', async () => {
    const { mint, receiver } = receiverFixture();
    await receiver.reset('receiver-seed');
    const request = await receiver.createRequest({
      amount: 8,
      unit: 'sat',
      transports: ['http'],
      singleUse: true,
      expiresIn: 900,
    });

    expect(request.id).toHaveLength(requestId.length);
    expect(
      PaymentRequest.fromEncodedRequest(request.raw).getTransport(PaymentRequestTransportType.POST)
        ?.target,
    ).toBe(paymentTarget);

    const receipt = await receiver.receive(serializeDeliveryPayload(payload(request.id)));
    expect(receipt).toMatchObject({
      profile: 'cashu-delivery-v1',
      request_id: request.id,
      delivery_id: deliveryId,
      status: 'settled',
      status_version: 3,
      payload_hash: computePayloadHash({
        requestId: parseProtocolId(request.id),
        memo: null,
        mint: mintUrl,
        unit: 'sat',
        proofs: [proof],
        createdAt: now,
        expiresAt: now + 900,
      }),
    });
    await expect(receiver.delivery(deliveryId)).resolves.toEqual(receipt);
    await expect(receiver.ledger()).resolves.toEqual([
      {
        requestId: request.id,
        deliveryId,
        amount: 8,
        unit: 'sat',
        creditCount: 1,
        createdAt: now,
      },
    ]);
    await expect(receiver.proofs()).resolves.toEqual([
      { deliveryId, proofSetHash: 'b'.repeat(64), inputYs: [proofY], state: 'spent' },
    ]);
    expect(mint.prepareCalls).toBe(1);
    expect(mint.swapCalls).toBe(1);
  });

  it('serves dual-role capabilities and accepts payment bytes through /pay', async () => {
    const { receiver } = receiverFixture();
    const sender = new FundedCashuTsDualRoleOperations({
      sender: {
        wallet: new SenderWallet(),
        transport: {
          async post(_target: string, body: Uint8Array) {
            return receiver.receive(body);
          },
        } satisfies CashuTsTransportPort,
        now: () => now,
      },
      receiver,
    });
    const app = await buildCashuTsAdapterServer({
      testMode: true,
      now: () => now,
      operations: sender,
    });
    try {
      const capabilities = (await app.inject({ method: 'GET', url: '/v1/capabilities' })).json();
      expect(capabilities.profiles).toContainEqual({
        name: 'delivery-v1',
        roles: ['sender', 'receiver'],
        status: 'supported',
      });

      await expect(sender.reset('dual-role-seed')).resolves.toBeUndefined();
      const request = await sender.createRequest({
        amount: 8,
        unit: 'sat',
        transports: ['http'],
        singleUse: true,
        expiresIn: 900,
      });
      const response = await app.inject({
        method: 'POST',
        url: '/pay',
        headers: { 'content-type': 'application/json' },
        payload: Buffer.from(serializeDeliveryPayload(payload(request.id))),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ delivery_id: deliveryId, status: 'settled' });
    } finally {
      await app.close();
    }
  });

  it('preserves sender-only proof evidence without duplicating receiver proof evidence', async () => {
    const { receiver } = receiverFixture();
    const operations = new FundedCashuTsDualRoleOperations({
      sender: {
        wallet: new SenderWallet(),
        transport: {
          async post(_target: string, body: Uint8Array) {
            return settledReceipt(body);
          },
        } satisfies CashuTsTransportPort,
        now: () => now,
      },
      receiver,
    });
    await operations.reset('dual-role-proof-composition');

    const externalRequest = new PaymentRequest(
      [{ type: PaymentRequestTransportType.POST, target: 'http://127.0.0.1:4102/pay' }],
      requestId,
      8,
      'sat',
      [mintUrl],
      'external receiver',
      true,
    ).toEncodedCreqA();
    const senderReceipt = await operations.send({ request: externalRequest });
    const overlappingSenderReceipt = await operations.send({
      request: externalRequest,
      deliveryId,
    });

    const receiverRequest = await operations.createRequest({
      amount: 8,
      unit: 'sat',
      transports: ['http'],
      singleUse: true,
      expiresIn: 900,
    });
    const receiverReceipt = await operations.receive(
      serializeDeliveryPayload(payload(receiverRequest.id)),
    );

    const proofs = await operations.proofs();
    expect(
      proofs.filter((candidate) => candidate.deliveryId === senderReceipt.delivery_id),
    ).toEqual([expect.objectContaining({ proofSetHash: 'd'.repeat(64), state: 'spent' })]);
    expect(
      proofs.filter((candidate) => candidate.deliveryId === overlappingSenderReceipt.delivery_id),
    ).toEqual([expect.objectContaining({ proofSetHash: 'b'.repeat(64), state: 'spent' })]);
    expect(receiverReceipt.delivery_id).toBe(overlappingSenderReceipt.delivery_id);
  });

  it('keeps control endpoints bearer-gated without requiring control auth on /pay', async () => {
    const { receiver } = receiverFixture();
    await receiver.reset('payment-route-auth');
    const request = await receiver.createRequest({
      amount: 8,
      unit: 'sat',
      transports: ['http'],
      singleUse: true,
      expiresIn: 900,
    });
    const app = await buildCashuTsAdapterServer({
      controlToken: 'control-token',
      now: () => now,
      operations: {
        send: async () => {
          throw new Error('unused');
        },
        receive: (body) => receiver.receive(body),
        delivery: (id) => receiver.delivery(id),
        ledger: () => receiver.ledger(),
        proofs: () => receiver.proofs(),
      },
    });
    try {
      const unauthorizedControl = await app.inject({ method: 'GET', url: '/v1/capabilities' });
      expect(unauthorizedControl.statusCode).toBe(401);

      const payment = await app.inject({
        method: 'POST',
        url: '/pay',
        headers: { 'content-type': 'application/json' },
        payload: Buffer.from(serializeDeliveryPayload(payload(request.id))),
      });
      expect(payment.statusCode).toBe(200);
      expect(payment.json()).toMatchObject({ delivery_id: deliveryId, status: 'settled' });
    } finally {
      await app.close();
    }
  });

  it('does not expose unexpected receiver internals from the public payment route', async () => {
    const app = await buildCashuTsAdapterServer({
      controlToken: 'control-token',
      now: () => now,
      operations: {
        send: async () => {
          throw new Error('unused');
        },
        receive: async () => {
          throw new Error('mint api key leaked in diagnostic');
        },
        delivery: async () => {
          throw new Error('unused');
        },
        ledger: async () => [],
        proofs: async () => [],
      },
    });
    try {
      const payment = await app.inject({
        method: 'POST',
        url: '/pay',
        headers: { 'content-type': 'application/json' },
        payload: Buffer.from(serializeDeliveryPayload(payload())),
      });
      expect(payment.statusCode).toBe(500);
      expect(payment.json()).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(payment.body).not.toContain('mint api key');
    } finally {
      await app.close();
    }
  });
});
