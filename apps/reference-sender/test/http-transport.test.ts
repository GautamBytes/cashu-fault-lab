import { describe, expect, it, vi } from 'vitest';
import { HttpPaymentTransport } from '../src/http/payment-transport.js';

const target = { type: 'post', target: 'https://merchant.example/pay' } as const;
const payload = new TextEncoder().encode('{"delivery":"same-bytes"}');
const receipt = {
  profile: 'cashu-delivery-v1',
  request_id: 'AAECAwQFBgcICQoLDA0ODw',
  delivery_id: 'EBESExQVFhcYGRobHB0eHw',
  payload_hash: 'a'.repeat(64),
  status: 'settled',
  status_version: 1,
  mint: 'https://mint.example',
  unit: 'sat',
  amount: 8,
  detail_code: 'settled',
} as const;

describe('HttpPaymentTransport', () => {
  it.each([200, 202, 409, 410, 413, 422])('parses receipts from HTTP %i', async (status) => {
    const fetch = vi.fn(async () => Response.json(receipt, { status }));
    const transport = new HttpPaymentTransport({ fetch, timeoutMs: 1_000 });

    await expect(transport.send(payload, target, new AbortController().signal)).resolves.toEqual({
      kind: 'receipt',
      receipt,
    });
    expect(fetch).toHaveBeenCalledWith(
      target.target,
      expect.objectContaining({
        method: 'POST',
        body: payload,
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it.each([429, 500, 502, 503])('classifies HTTP %i as retryable no-response', async (status) => {
    const transport = new HttpPaymentTransport({
      fetch: async () => new Response(null, { status }),
      timeoutMs: 1_000,
    });
    await expect(transport.send(payload, target, new AbortController().signal)).resolves.toEqual({
      kind: 'no_response',
    });
  });

  it('stops on a stable permanent error without following redirects', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ code: 'DELIVERY_CONFLICT', message: 'conflict' }, { status: 409 }),
    );
    const transport = new HttpPaymentTransport({ fetch, timeoutMs: 1_000 });

    await expect(transport.send(payload, target, new AbortController().signal)).resolves.toEqual({
      kind: 'permanent_failure',
      status: 409,
      code: 'DELIVERY_CONFLICT',
    });
    expect(fetch).toHaveBeenCalledWith(
      target.target,
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects oversized response bodies and non-HTTP targets', async () => {
    const transport = new HttpPaymentTransport({
      fetch: async () => new Response('x'.repeat(65_537), { status: 200 }),
      timeoutMs: 1_000,
    });
    await expect(
      transport.send(payload, target, new AbortController().signal),
    ).rejects.toThrowError(/response.*large/i);
    await expect(
      transport.send(
        payload,
        { type: 'nostr', target: 'nprofile1qqspseudotarget' },
        new AbortController().signal,
      ),
    ).rejects.toThrowError(/HTTP transport.*post/i);
  });
});
