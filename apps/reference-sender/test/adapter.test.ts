import type { AdapterCapabilities, SendPaymentInput } from '@cashu-fault-lab/adapter-contract';
import type { DeliveryReceiptWire } from '@cashu-fault-lab/delivery-core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSenderAdapterServer, type SenderAdapterControl } from '../src/http/adapter-server.js';

const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const receipt: DeliveryReceiptWire = {
  profile: 'cashu-delivery-v1',
  request_id: 'AAECAwQFBgcICQoLDA0ODw',
  delivery_id: deliveryId,
  payload_hash: 'a'.repeat(64),
  status: 'settled',
  status_version: 1,
  mint: 'https://mint.example',
  unit: 'sat',
  amount: 8,
  detail_code: 'settled',
};

class FakeControl implements SenderAdapterControl {
  sendCalls = 0;

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      implementation: 'reference-sender',
      version: '0.0.0',
      nuts: [18],
      transports: ['http'],
      evidenceTier: 'T3',
    };
  }

  async reset(): Promise<void> {}

  async send(_input: SendPaymentInput): Promise<DeliveryReceiptWire> {
    this.sendCalls += 1;
    return receipt;
  }

  async delivery(): Promise<DeliveryReceiptWire> {
    return receipt;
  }
}

const apps: Array<Awaited<ReturnType<typeof buildSenderAdapterServer>>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('sender adapter API', () => {
  it('serves contract-valid capabilities, send, reset, and delivery routes', async () => {
    const control = new FakeControl();
    const app = await buildSenderAdapterServer({ control, testMode: true });
    apps.push(app);

    expect((await app.inject({ method: 'GET', url: '/v1/capabilities' })).json()).toEqual(
      await control.capabilities(),
    );
    const reset = await app.inject({
      method: 'POST',
      url: '/v1/reset',
      payload: { seed: 'seed-1' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ ok: true });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/send',
          payload: { request: 'creqA-test' },
        })
      ).json(),
    ).toEqual(receipt);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/deliveries/${deliveryId}` })).json(),
    ).toEqual(receipt);
  });

  it('rejects invalid requests before invoking control code', async () => {
    const control = new FakeControl();
    const app = await buildSenderAdapterServer({ control, testMode: true });
    apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/v1/send', payload: {} });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'SCHEMA_REQUIRED' });
    expect(control.sendCalls).toBe(0);
  });

  it('requires a configured bearer token outside explicit test mode', async () => {
    await expect(buildSenderAdapterServer({ control: new FakeControl() })).rejects.toThrowError(
      /control token/i,
    );
    const app = await buildSenderAdapterServer({
      control: new FakeControl(),
      controlToken: 'test-control-secret',
    });
    apps.push(app);

    expect((await app.inject({ method: 'GET', url: '/v1/capabilities' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/capabilities',
          headers: { authorization: 'Bearer test-control-secret' },
        })
      ).statusCode,
    ).toBe(200);
  });
});
