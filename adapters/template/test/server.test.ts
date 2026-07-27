import { createAdapterServer } from '../src/server.js';
import { describe, expect, it } from 'vitest';

describe('template adapter', () => {
  it('starts and returns capabilities', async () => {
    const server = createAdapterServer({ token: 'test-token' });
    await server.ready();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/capabilities',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.nuts).toEqual([18]);
    expect(body).toMatchObject({
      schemaVersion: 2,
      implementation: { id: 'template' },
      roles: {
        sender: {
          profiles: ['template'],
          durability: 'process',
          evidence: { tier: 'T0', sources: ['adapter'] },
        },
      },
    });
  });

  it('rejects requests without a valid bearer token', async () => {
    const server = createAdapterServer({ token: 'test-token' });
    await server.ready();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/capabilities',
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 501 N/A for unimplemented routes', async () => {
    const server = createAdapterServer({ token: 'test-token' });
    await server.ready();

    const response = await server.inject({
      method: 'POST',
      url: '/v1/reset',
      headers: { authorization: 'Bearer test-token' },
      payload: { seed: 'test' },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json().status).toBe('N/A');
  });
});
