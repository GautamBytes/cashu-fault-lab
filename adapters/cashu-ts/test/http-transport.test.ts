import { describe, expect, it } from 'vitest';
import { CashuTsHttpTransport } from '../src/http-transport.js';

const receipt = {
  profile: 'cashu-delivery-v1' as const,
  request_id: 'AAECAwQFBgcICQoLDA0ODw',
  delivery_id: 'EBESExQVFhcYGRobHB0eHw',
  payload_hash: 'a'.repeat(64),
  status: 'settled' as const,
  status_version: 2,
  mint: 'https://mint.example',
  unit: 'sat',
  amount: 8,
  detail_code: 'settled',
};

describe('CashuTsHttpTransport', () => {
  it('posts exact JSON bytes without retrying or following redirects', async () => {
    const calls: Uint8Array[] = [];
    const transport = new CashuTsHttpTransport({
      fetch: async (_input, init) => {
        calls.push(Uint8Array.from(init?.body as Uint8Array));
        expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
        return Response.json(receipt);
      },
    });
    const body = new TextEncoder().encode('{"proof":"opaque"}');

    await expect(transport.post('http://127.0.0.1:8181/pay', body)).resolves.toEqual(receipt);
    expect(calls).toHaveLength(1);
    expect(Buffer.compare(calls[0]!, body)).toBe(0);

    const redirecting = new CashuTsHttpTransport({
      fetch: async () => new Response(null, { status: 302, headers: { location: 'https://x' } }),
    });
    await expect(redirecting.post('http://127.0.0.1:8181/pay', body)).rejects.toThrow(
      'Cashu payment redirect is forbidden',
    );
  });
});
