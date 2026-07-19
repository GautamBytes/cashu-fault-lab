import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { validateAdapterResponse } from '@cashu-fault-lab/adapter-contract';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCashuTsAdapterServer } from '../src/index.js';

interface UpstreamVector {
  readonly name: string;
  readonly encoded: string;
  readonly expected_id: string;
}

const vectors = (
  JSON.parse(
    readFileSync(
      new URL('../../../spec/vectors/upstream-payment-requests.json', import.meta.url),
      'utf8',
    ),
  ) as { readonly vectors: readonly UpstreamVector[] }
).vectors;

describe('cashu-ts adapter contract', () => {
  it('exposes honest T0 capabilities and creates canonical NUT-18 requests', async () => {
    const app = await buildCashuTsAdapterServer({
      testMode: true,
      now: () => 1_784_399_400,
      httpTarget: 'https://merchant.example/pay',
      nostrTarget:
        'nprofile1qy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsz9mhwden5te0wfjkccte9curxven9eehqctrv5hszrthwden5te0dehhxtnvdakqqgydaqy7curk439ykptkysv7udhdhu68sucm295akqefdehkf0d495cwunl5',
    });
    try {
      const capabilities = (await app.inject({ method: 'GET', url: '/v1/capabilities' })).json();
      expect(validateAdapterResponse('capabilities', capabilities)).toEqual({ ok: true });
      expect(capabilities).toMatchObject({
        implementation: 'cashu-ts',
        version: '4.7.2',
        evidenceTier: 'T0',
        encodings: ['creqA', 'creqB'],
      });

      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/reset',
            payload: { seed: 'adapter-seed' },
          })
        ).statusCode,
      ).toBe(200);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/requests',
        payload: {
          amount: 8,
          unit: 'sat',
          description: 'order-42',
          transports: ['http', 'nostr'],
          singleUse: true,
          expiresIn: 900,
        },
      });
      expect(response.statusCode).toBe(200);
      const view = response.json();
      expect(validateAdapterResponse('createRequest', view)).toEqual({ ok: true });
      const decoded = PaymentRequest.fromEncodedRequest(view.raw);
      expect(decoded.id).toBe(view.id);
      expect(decoded.amount?.toString()).toBe('8');
      expect(decoded.getTransport(PaymentRequestTransportType.POST)?.target).toBe(
        'https://merchant.example/pay',
      );
      expect(decoded.getTransport(PaymentRequestTransportType.NOSTR)?.tags).toEqual([['n', '17']]);
    } finally {
      await app.close();
    }
  });

  it('returns N/A instead of pretending an unfunded codec adapter can send', async () => {
    const app = await buildCashuTsAdapterServer({ testMode: true, now: () => 1 });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/send',
        payload: { request: 'creqAexample' },
      });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toMatchObject({ status: 'N/A', reason: expect.any(String) });
    } finally {
      await app.close();
    }
  });

  it('round-trips the official pinned NUT-26 codec vector without calling it NIP-17', () => {
    const vector = vectors.find(({ name }) => name === 'nut26-creqB-basic')!;
    const decoded = PaymentRequest.fromEncodedRequest(vector.encoded);
    expect(decoded.id).toBe('demo123');
    expect(decoded.toEncodedCreqB()).toBe(vector.encoded);
  });
});
