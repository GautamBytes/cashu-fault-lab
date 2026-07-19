import { describe, expect, it } from 'vitest';
import { HttpExternalFaultController } from '../src/external-http-fault-controller.js';

describe('HttpExternalFaultController', () => {
  it('authenticates and maps scenario faults to gateway control rules', async () => {
    const calls: Array<{ method: string; url: string; authorization: string; body?: unknown }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        method: init?.method ?? 'GET',
        url,
        authorization: new Headers(init?.headers).get('authorization') ?? '',
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      if (url.endsWith('/evidence')) {
        return Response.json({ inbound: 2, forwarded: 2 });
      }
      return Response.json({ ok: true });
    };
    const controller = new HttpExternalFaultController({
      baseUrl: 'http://127.0.0.1:4200',
      token: 'fault-secret',
      fetch: fakeFetch,
    });

    await controller.reset();
    await controller.configure('http', { kind: 'drop_response', occurrence: 2 });
    await expect(controller.evidence()).resolves.toEqual({ inbound: 2, forwarded: 2 });
    await controller.clear('http');

    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'http://127.0.0.1:4200/__faults/v1/reset',
        authorization: 'Bearer fault-secret',
      },
      {
        method: 'POST',
        url: 'http://127.0.0.1:4200/__faults/v1/rules',
        authorization: 'Bearer fault-secret',
        body: {
          phase: 'after_downstream_response',
          action: 'drop',
          occurrence: 2,
          count: 1,
        },
      },
      {
        method: 'GET',
        url: 'http://127.0.0.1:4200/__faults/v1/evidence',
        authorization: 'Bearer fault-secret',
      },
      {
        method: 'DELETE',
        url: 'http://127.0.0.1:4200/__faults/v1/rules',
        authorization: 'Bearer fault-secret',
      },
    ]);
  });

  it('rejects redirects and unsupported targets without leaking dependency details', async () => {
    const controller = new HttpExternalFaultController({
      baseUrl: 'http://127.0.0.1:4200',
      token: 'fault-secret',
      fetch: async () => new Response(null, { status: 302, headers: { location: 'https://x' } }),
    });

    await expect(controller.reset()).rejects.toThrow('External fault controller redirect');
    await expect(controller.configure('nostr', { kind: 'drop_response' })).rejects.toThrow(
      'only supports HTTP',
    );
  });
});
