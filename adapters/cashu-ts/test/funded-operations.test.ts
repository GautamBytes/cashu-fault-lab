import {
  PaymentRequest,
  PaymentRequestTransportType,
  type PaymentRequestTransport,
} from '@cashu/cashu-ts';
import {
  AdapterNotApplicableError,
  type AdapterTransport,
  type ProofEvidenceView,
} from '@cashu-fault-lab/adapter-contract';
import {
  computePayloadHash,
  parseDeliveryPayloadJson,
  type CashuProof,
} from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import {
  FundedCashuTsOperations,
  type CashuTsTransportPort,
  type CashuTsWalletPort,
  type ReservedCashuTsProofs,
} from '../src/funded-operations.js';
import { buildCashuTsAdapterServer } from '../src/server.js';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const proof: CashuProof = {
  amount: 8,
  id: '00aa',
  secret: 'funded-proof-secret',
  C: `02${'11'.repeat(32)}`,
};

function encodedRequest(
  amount = 8,
  transports: PaymentRequestTransport[] = [
    { type: PaymentRequestTransportType.POST, target: 'http://127.0.0.1:8181/pay' },
  ],
): string {
  return new PaymentRequest(
    transports,
    requestId,
    amount,
    'sat',
    ['https://mint.example'],
    'order-42',
    true,
  ).toEncodedCreqA();
}

class Wallet implements CashuTsWalletPort {
  reserveCalls = 0;
  settledCalls = 0;

  async reset(): Promise<void> {
    this.reserveCalls = 0;
    this.settledCalls = 0;
  }

  async reserve(): Promise<ReservedCashuTsProofs> {
    this.reserveCalls += 1;
    return { mint: 'https://mint.example', proofs: [proof] };
  }

  async markSettled(): Promise<void> {
    this.settledCalls += 1;
  }

  async evidence(selectedDeliveryId: string): Promise<ProofEvidenceView> {
    return {
      deliveryId: selectedDeliveryId,
      proofSetHash: 'b'.repeat(64),
      inputYs: [`02${'01'.repeat(32)}`],
      state: 'spent',
    };
  }
}

class Transport implements CashuTsTransportPort {
  readonly bodies: Uint8Array[] = [];
  readonly targets: string[] = [];
  loseFirstResponse = false;

  async send(
    target: { readonly type: 'post' | 'nostr'; readonly target: string },
    body: Uint8Array,
  ) {
    this.bodies.push(Uint8Array.from(body));
    this.targets.push(`${target.type}:${target.target}`);
    const payload = parseDeliveryPayloadJson(body, now);
    if (this.loseFirstResponse && this.bodies.length === 1) {
      throw new Error('receiver accepted but response was lost');
    }
    return {
      profile: 'cashu-delivery-v1' as const,
      request_id: payload.id,
      delivery_id: payload.delivery.id,
      payload_hash: computePayloadHash({
        requestId: payload.id,
        memo: payload.memo,
        mint: payload.mint,
        unit: payload.unit,
        proofs: payload.proofs,
        createdAt: payload.delivery.createdAt,
        expiresAt: payload.delivery.expiresAt,
      }),
      status: 'settled' as const,
      status_version: 2,
      mint: payload.mint,
      unit: payload.unit,
      amount: payload.proofs.reduce((sum, candidate) => sum + candidate.amount, 0),
      detail_code: 'settled',
    };
  }
}

function fixture(supportedTransports?: readonly AdapterTransport[]) {
  const wallet = new Wallet();
  const transport = new Transport();
  const operations = new FundedCashuTsOperations({
    wallet,
    transport,
    now: () => now,
    ...(supportedTransports === undefined ? {} : { supportedTransports }),
  });
  return { wallet, transport, operations };
}

describe('FundedCashuTsOperations', () => {
  it('publishes truthful funded sender capability and explicit receiver N/A', async () => {
    const { operations } = fixture();
    const app = await buildCashuTsAdapterServer({
      testMode: true,
      now: () => now,
      operations,
    });
    try {
      const capabilities = (await app.inject({ method: 'GET', url: '/v1/capabilities' })).json();
      expect(capabilities).toMatchObject({
        implementation: 'cashu-ts',
        evidenceTier: 'T1',
        profiles: expect.arrayContaining([
          {
            name: 'delivery-v1',
            roles: ['sender'],
            status: 'supported',
          },
        ]),
      });
      const ledger = await app.inject({ method: 'GET', url: '/v1/ledger' });
      expect(ledger.json()).toEqual({
        status: 'N/A',
        reason: 'Sender-only cashu-ts adapter has no merchant ledger',
      });
      expect(ledger.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  it('reserves once and retransmits the exact persisted payload for one delivery', async () => {
    const { wallet, transport, operations } = fixture();
    await operations.reset('funded-seed');

    const first = await operations.send({ request: encodedRequest(), deliveryId });
    const second = await operations.send({ request: encodedRequest(), deliveryId });

    expect(first).toEqual(second);
    expect(wallet.reserveCalls).toBe(1);
    expect(wallet.settledCalls).toBe(1);
    expect(transport.bodies).toHaveLength(2);
    expect(Buffer.compare(transport.bodies[0]!, transport.bodies[1]!)).toBe(0);
    await expect(operations.delivery(deliveryId)).resolves.toEqual(first);
    await expect(operations.proofs()).resolves.toEqual([
      expect.objectContaining({ deliveryId, state: 'spent' }),
    ]);
    await expect(operations.ledger()).rejects.toBeInstanceOf(AdapterNotApplicableError);
  });

  it('recovers a lost response with the same proof reservation and bytes', async () => {
    const { wallet, transport, operations } = fixture();
    transport.loseFirstResponse = true;
    await operations.reset('response-loss');

    await expect(operations.send({ request: encodedRequest(), deliveryId })).rejects.toThrow(
      'Cashu payment delivery failed',
    );
    await expect(operations.send({ request: encodedRequest(), deliveryId })).resolves.toMatchObject(
      { status: 'settled' },
    );

    expect(wallet.reserveCalls).toBe(1);
    expect(transport.bodies).toHaveLength(2);
    expect(Buffer.compare(transport.bodies[0]!, transport.bodies[1]!)).toBe(0);
  });

  it('falls back to the next Nostr transport without changing reservation or bytes', async () => {
    const { wallet, transport, operations } = fixture(['http', 'nostr']);
    transport.loseFirstResponse = true;
    await operations.reset('nostr-fallback');
    const request = encodedRequest(8, [
      { type: PaymentRequestTransportType.POST, target: 'http://127.0.0.1:8181/pay' },
      {
        type: PaymentRequestTransportType.NOSTR,
        target:
          'nprofile1qqsqv9jxgu33waryc6rulmzy58qx22tdp8wraj4l78k35nvnu4d0w5qprpmhxue69uhkummnw3ezuamfdejj7q3q0lr8',
        tags: [['n', '17']],
      },
    ]);

    await expect(operations.send({ request, deliveryId })).rejects.toThrow(
      'Cashu payment delivery failed',
    );
    await expect(operations.send({ request, deliveryId })).resolves.toMatchObject({
      status: 'settled',
    });

    expect(wallet.reserveCalls).toBe(1);
    expect(transport.targets).toEqual([
      'post:http://127.0.0.1:8181/pay',
      'nostr:nprofile1qqsqv9jxgu33waryc6rulmzy58qx22tdp8wraj4l78k35nvnu4d0w5qprpmhxue69uhkummnw3ezuamfdejj7q3q0lr8',
    ]);
    expect(Buffer.compare(transport.bodies[0]!, transport.bodies[1]!)).toBe(0);
  });

  it('rejects unsupported request transports before reserving proofs', async () => {
    const { wallet, transport, operations } = fixture();
    await operations.reset('unsupported-transport');
    const request = encodedRequest(8, [
      {
        type: PaymentRequestTransportType.NOSTR,
        target:
          'nprofile1qqsqv9jxgu33waryc6rulmzy58qx22tdp8wraj4l78k35nvnu4d0w5qprpmhxue69uhkummnw3ezuamfdejj7q3q0lr8',
        tags: [['n', '17']],
      },
    ]);

    await expect(operations.send({ request, deliveryId })).rejects.toThrow(
      'Cashu payment request does not contain a supported transport',
    );

    expect(wallet.reserveCalls).toBe(0);
    expect(transport.bodies).toHaveLength(0);
  });

  it('rejects rebinding one delivery ID to a changed request', async () => {
    const { wallet, transport, operations } = fixture();
    await operations.reset('request-conflict');
    await operations.send({ request: encodedRequest(), deliveryId });

    await expect(operations.send({ request: encodedRequest(9), deliveryId })).rejects.toThrow(
      'Delivery ID is already bound to another payment request',
    );
    expect(wallet.reserveCalls).toBe(1);
    expect(transport.bodies).toHaveLength(1);

    await expect(
      operations.send({ request: encodedRequest(), deliveryId, memo: 'changed' }),
    ).rejects.toThrow('Delivery ID is already bound to another payment request');
    expect(transport.bodies).toHaveLength(1);
  });
});
