import { serializeDeliveryPayload } from '@cashu-fault-lab/delivery-core';
import type {
  AdapterCapabilities,
  CreateRequestInput,
  LedgerCreditView,
  PaymentRequestView,
  ProofEvidenceView,
} from '@cashu-fault-lab/adapter-contract';
import type { DeliveryReceiptWire } from '@cashu-fault-lab/delivery-core';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryReceiverStore } from '../src/adapters/memory-store.js';
import { buildReceiverHttpServer } from '../src/http/server.js';
import type { ReceiverAdapterControl } from '../src/http/adapter-routes.js';
import { FakeMint, FakeProofVerifier, payload } from './fakes.js';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';

async function fixture(mintMode: 'success' | 'timeout_after_commit' = 'success') {
  const store = new MemoryReceiverStore();
  await store.createRequest({
    id: requestId,
    amount: 8,
    unit: 'sat',
    mints: ['https://mint.example'],
    singleUse: true,
    expiresAt: now + 900,
  });
  const mint = new FakeMint();
  mint.mode = mintMode;
  const app = await buildReceiverHttpServer({
    accept: { store, mint, verifier: new FakeProofVerifier(), now: () => now },
    corsOrigins: ['https://shop.example'],
  });
  return { app, mint, store };
}

const apps: Array<Awaited<ReturnType<typeof buildReceiverHttpServer>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp(mode: 'success' | 'timeout_after_commit' = 'success') {
  const result = await fixture(mode);
  apps.push(result.app);
  return result;
}

describe('NUT-18 HTTP payment receiver', () => {
  it('returns one settled receipt for byte-identical retries', async () => {
    const { app, mint, store } = await createApp();
    const body = serializeDeliveryPayload(payload(requestId, deliveryId, now));
    const first = await app.inject({
      method: 'POST',
      url: '/pay',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(body),
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/pay',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(body),
    });

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual(first.json());
    expect(mint.swapCalls).toBe(1);
    expect(await store.credits()).toHaveLength(1);
  });

  it('maps delivery conflicts and expiry to stable HTTP errors', async () => {
    const { app } = await createApp();
    const original = serializeDeliveryPayload(payload(requestId, deliveryId, now));
    await app.inject({
      method: 'POST',
      url: '/pay',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(original),
    });
    const conflicting = serializeDeliveryPayload(
      payload(requestId, deliveryId, now, {
        proofs: [{ amount: 8, id: '00aa', secret: 'secret-b', C: '03bb' }],
      }),
    );
    const conflict = await app.inject({
      method: 'POST',
      url: '/pay',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(conflicting),
    });
    const expired = await app.inject({
      method: 'POST',
      url: '/pay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        id: requestId,
        mint: 'https://mint.example',
        unit: 'sat',
        proofs: [],
        delivery: {
          v: 1,
          id: 'ICEiIyQlJicoKSorLC0uLw',
          created_at: now - 1_000,
          expires_at: now - 61,
        },
      }),
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'DELIVERY_CONFLICT' });
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ code: 'DELIVERY_EXPIRED' });
  });

  it('rejects oversized and wrong-content-type bodies before domain processing', async () => {
    const { app, mint } = await createApp();
    const oversized = await app.inject({
      method: 'POST',
      url: '/pay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'x'.repeat(65_536) }),
    });
    const wrongType = await app.inject({
      method: 'POST',
      url: '/pay',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });

    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(wrongType.statusCode).toBe(415);
    expect(mint.swapCalls).toBe(0);
  });

  it('returns 202 with Retry-After while recovery is required', async () => {
    const { app } = await createApp('timeout_after_commit');
    const response = await app.inject({
      method: 'POST',
      url: '/pay',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(serializeDeliveryPayload(payload(requestId, deliveryId, now))),
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toMatchObject({
      status: 'processing',
      detail_code: 'recovery_blocked',
    });
  });

  it('allows only configured CORS origins without credentials', async () => {
    const { app } = await createApp();
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/pay',
      headers: {
        origin: 'https://shop.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/pay',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'POST',
      },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('https://shop.example');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

const adapterReceipt: DeliveryReceiptWire = {
  profile: 'cashu-delivery-v1',
  request_id: requestId,
  delivery_id: deliveryId,
  payload_hash: 'a'.repeat(64),
  status: 'settled',
  status_version: 1,
  mint: 'https://mint.example',
  unit: 'sat',
  amount: 8,
  detail_code: 'settled',
};

class FakeAdapterControl implements ReceiverAdapterControl {
  createCalls = 0;

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      implementation: 'reference-receiver',
      version: '0.0.0',
      nuts: [18],
      transports: ['http'],
      evidenceTier: 'T3',
    };
  }

  async reset(): Promise<void> {}

  async createRequest(_input: CreateRequestInput): Promise<PaymentRequestView> {
    this.createCalls += 1;
    return {
      id: requestId,
      raw: 'creqAtest',
      amount: 8,
      unit: 'sat',
      singleUse: true,
      expiresAt: now + 900,
      transports: [{ type: 'post', target: 'https://merchant.example/pay' }],
    };
  }

  async delivery(): Promise<DeliveryReceiptWire> {
    return adapterReceipt;
  }

  async ledger(): Promise<readonly LedgerCreditView[]> {
    return [
      {
        requestId,
        deliveryId,
        amount: 8,
        unit: 'sat',
        creditCount: 1,
        createdAt: now,
      },
    ];
  }

  async proofs(): Promise<readonly ProofEvidenceView[]> {
    return [
      {
        deliveryId,
        proofSetHash: 'a'.repeat(64),
        inputYs: [`02${'11'.repeat(32)}`],
        state: 'spent',
      },
    ];
  }
}

async function adapterFixture(options: { readonly testMode?: boolean; readonly token?: string }) {
  const store = new MemoryReceiverStore();
  const control = new FakeAdapterControl();
  const app = await buildReceiverHttpServer({
    accept: { store, mint: new FakeMint(), verifier: new FakeProofVerifier(), now: () => now },
    adapter: {
      control,
      ...(options.testMode === undefined ? {} : { testMode: options.testMode }),
      ...(options.token === undefined ? {} : { controlToken: options.token }),
    },
  });
  apps.push(app);
  return { app, control };
}

describe('receiver adapter API', () => {
  it('serves schema-valid receiver control routes', async () => {
    const { app } = await adapterFixture({ testMode: true });
    expect((await app.inject({ method: 'GET', url: '/v1/capabilities' })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/reset',
          payload: { seed: 'receiver-seed' },
        })
      ).json(),
    ).toEqual({ ok: true });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/requests',
          payload: {
            amount: 8,
            unit: 'sat',
            transports: ['http'],
            singleUse: true,
            expiresIn: 900,
          },
        })
      ).json(),
    ).toMatchObject({ id: requestId, raw: 'creqAtest' });
    expect(
      (await app.inject({ method: 'GET', url: `/v1/deliveries/${deliveryId}` })).json(),
    ).toEqual(adapterReceipt);
    expect((await app.inject({ method: 'GET', url: '/v1/ledger' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/v1/proofs' })).json()).toHaveLength(1);
  });

  it('rejects invalid request creation before control invocation', async () => {
    const { app, control } = await adapterFixture({ testMode: true });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/requests',
      payload: { amount: -1 },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'SCHEMA_REQUIRED' });
    expect(control.createCalls).toBe(0);
  });

  it('requires bearer authentication outside explicit test mode', async () => {
    await expect(
      buildReceiverHttpServer({
        accept: {
          store: new MemoryReceiverStore(),
          mint: new FakeMint(),
          verifier: new FakeProofVerifier(),
          now: () => now,
        },
        adapter: { control: new FakeAdapterControl() },
      }),
    ).rejects.toThrowError(/control token/i);

    const { app } = await adapterFixture({ token: 'receiver-control-secret' });
    expect((await app.inject({ method: 'GET', url: '/v1/capabilities' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/capabilities',
          headers: { authorization: 'Bearer receiver-control-secret' },
        })
      ).statusCode,
    ).toBe(200);
  });
});
