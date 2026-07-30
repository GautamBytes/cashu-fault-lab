import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { parseProtocolId } from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import { MemoryReceiverStore } from '../src/adapters/memory-store.js';
import { FundedReceiverAdapterControl } from '../src/funded-adapter.js';
import { FakeMint, FakeProofVerifier, payload } from './fakes.js';

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
      schemaVersion: 2,
      implementation: { id: 'reference-receiver' },
      roles: {
        receiver: {
          profiles: ['delivery-v1'],
          durability: 'process',
          evidence: {
            tier: 'T1',
            sources: ['adapter', 'runner', 'transport', 'mint'],
          },
        },
      },
    });
    expect(request).toMatchObject({ amount: 8, unit: 'sat', singleUse: true });
    expect(request.raw).toMatch(/^creqA[A-Za-z0-9_-]+$/);
    expect(decoded.id).toBe(request.id);
    expect(decoded.singleUse).toBe(true);
    expect(decoded.getTransport(PaymentRequestTransportType.POST)).toMatchObject({
      target: 'http://127.0.0.1:4200/pay',
      tags: [
        ['delivery', '1'],
        ['expires_at', String(now + 900)],
      ],
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

  it('uses an HTTP target origin override while preserving the receiver payment path', async () => {
    const control = new FundedReceiverAdapterControl({
      store: new MemoryReceiverStore(),
      mintUrl: 'https://mint.example',
      paymentTarget: 'http://127.0.0.1:4200/pay',
      now: () => now,
    });
    await control.reset('receiver-seed');

    const request = await control.createRequest({
      amount: 8,
      unit: 'sat',
      transports: ['http'],
      httpTarget: 'http://127.0.0.1:4300',
      singleUse: true,
      expiresIn: 900,
    });

    expect(request.transports).toEqual([{ type: 'post', target: 'http://127.0.0.1:4300/pay' }]);
    expect(
      PaymentRequest.fromEncodedRequest(request.raw).getTransport(PaymentRequestTransportType.POST),
    ).toMatchObject({ target: 'http://127.0.0.1:4300/pay' });
  });

  it('reports the cumulative redemption starts recorded at dispatch', async () => {
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
    const candidate = payload(request.id, 'EBESExQVFhcYGRobHB0eHw', now);
    const inspected = await new FakeProofVerifier().inspect({ payload: candidate });
    const plan = await new FakeMint().prepareSwap({
      version: 1,
      deliveryId: candidate.delivery.id,
      mint: candidate.mint,
      unit: candidate.unit,
      expectedAmount: inspected.netAmount,
      inputProofs: candidate.proofs,
      proofYs: inspected.ys,
    });
    await store.prepare({
      command: { payload: candidate, payloadHash: 'a'.repeat(64) },
      proofSetHash: inspected.proofSetHash,
      proofClaimIds: inspected.proofClaimIds,
      proofYs: inspected.ys,
      netAmount: inspected.netAmount,
      plan,
      now,
    });

    expect(await control.redemptions()).toEqual([]);
    await store.markMintSent(candidate.delivery.id);
    expect(await control.redemptions()).toEqual([]);

    await store.recordRedemptionStart(candidate.delivery.id);
    expect(await control.redemptions()).toEqual([
      {
        deliveryId: candidate.delivery.id,
        proofSetHash: inspected.proofSetHash,
        starts: 1,
      },
    ]);

    await store.recordRedemptionStart(candidate.delivery.id);
    expect(await control.redemptions()).toEqual([
      {
        deliveryId: candidate.delivery.id,
        proofSetHash: inspected.proofSetHash,
        starts: 2,
      },
    ]);
  });
});
