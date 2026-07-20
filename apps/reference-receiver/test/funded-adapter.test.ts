import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { parseProtocolId } from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import { MemoryReceiverStore } from '../src/adapters/memory-store.js';
import { FundedReceiverAdapterControl } from '../src/funded-adapter.js';

const now = 1_784_399_400;

describe('FundedReceiverAdapterControl', () => {
  it('creates a real single-use NUT-18 HTTP request and publishes honest receiver evidence', async () => {
    const store = new MemoryReceiverStore();
    const control = new FundedReceiverAdapterControl({
      store,
      mintUrl: 'https://mint.example',
      paymentTarget: 'http://127.0.0.1:4200/pay',
      now: () => now,
    });
    await control.reset('receiver-seed');

    const request = await control.createRequest({
      amount: 8,
      unit: 'sat',
      transports: ['http'],
      singleUse: true,
      expiresIn: 900,
    });
    const decoded = PaymentRequest.fromEncodedRequest(request.raw);

    expect(await control.capabilities()).toMatchObject({
      implementation: 'reference-receiver',
      evidenceTier: 'T1',
      profiles: expect.arrayContaining([
        {
          name: 'delivery-v1',
          roles: ['receiver'],
          status: 'supported',
        },
      ]),
    });
    expect(request).toMatchObject({ amount: 8, unit: 'sat', singleUse: true });
    expect(request.raw).toMatch(/^creqA[A-Za-z0-9_-]+$/);
    expect(decoded.id).toBe(request.id);
    expect(decoded.singleUse).toBe(true);
    expect(decoded.getTransport(PaymentRequestTransportType.POST)).toMatchObject({
      target: 'http://127.0.0.1:4200/pay',
      tags: [],
    });
    expect(
      await store.createRequest({
        id: request.id,
        amount: 8,
        unit: 'sat',
        mints: ['https://mint.example'],
        singleUse: true,
        expiresAt: now + 900,
      }),
    ).toMatchObject({ id: request.id });
  });

  it('clears prior request state on reset', async () => {
    const store = new MemoryReceiverStore();
    const control = new FundedReceiverAdapterControl({
      store,
      mintUrl: 'https://mint.example',
      paymentTarget: 'http://127.0.0.1:4200/pay',
      now: () => now,
    });
    await control.reset('first');
    const first = await control.createRequest({
      amount: 8,
      unit: 'sat',
      transports: ['http'],
      singleUse: true,
      expiresIn: 900,
    });
    await control.reset('second');

    await expect(
      store.preflight(
        {
          payload: {
            id: parseProtocolId(first.id),
            memo: null,
            mint: 'https://mint.example',
            unit: 'sat',
            proofs: [],
            delivery: {
              version: 1,
              id: parseProtocolId('EBESExQVFhcYGRobHB0eHw'),
              createdAt: now,
              expiresAt: now + 900,
            },
          },
          payloadHash: 'a'.repeat(64),
        },
        now,
      ),
    ).rejects.toThrow('Payment request not found');
  });
});
