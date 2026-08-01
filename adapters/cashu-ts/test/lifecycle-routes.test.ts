import type {
  LifecycleAdapterClient,
  LifecycleCapabilities,
  LifecycleOperationInput,
  LifecycleOperationView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import { describe, expect, test } from 'vitest';
import { buildCashuTsAdapterServer } from '../src/server.js';

const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
const mint = 'http://127.0.0.1:3338';
const capabilities: LifecycleCapabilities = {
  schemaVersion: 1,
  implementation: {
    id: 'cashu-ts',
    version: '4.7.2',
    language: 'typescript',
    runtime: 'node-24',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    buildDigest: `sha256:${'b'.repeat(64)}`,
  },
  operations: ['mint', 'swap', 'send', 'receive', 'melt', 'restore', 'reconcile'],
  nuts: [3, 4, 5, 7, 8, 9, 13, 19, 20, 23],
  durability: 'restart_safe',
  recovery: ['quote_state', 'proof_state', 'nut09_restore', 'nut13_seed', 'nut19_replay'],
  mints: [{ id: 'nutshell', implementation: 'nutshell' }],
};

class LifecycleOperations implements LifecycleAdapterClient {
  lastInput: LifecycleOperationInput | undefined;

  async capabilities(): Promise<LifecycleCapabilities> {
    return capabilities;
  }

  async reset(): Promise<void> {}

  async start(input: LifecycleOperationInput): Promise<LifecycleOperationView> {
    this.lastInput = input;
    return {
      operationId: input.operationId,
      kind: input.kind,
      mint: input.mint,
      unit: input.unit,
      intentHash: 'c'.repeat(64),
      phase: 'ambiguous',
      requestHash: 'd'.repeat(64),
    };
  }

  async resume(selectedOperationId: string): Promise<LifecycleOperationView> {
    return {
      operationId: selectedOperationId,
      kind: 'receive',
      mint,
      unit: 'sat',
      intentHash: 'c'.repeat(64),
      phase: 'succeeded',
    };
  }

  operation(selectedOperationId: string): Promise<LifecycleOperationView> {
    return this.resume(selectedOperationId);
  }

  async wallet() {
    return {
      walletId: 'cashu-ts',
      mint,
      unit: 'sat',
      balances: { available: 8, reserved: 0, recoverable: 0 },
      proofs: [{ proofId: 'e'.repeat(64), state: 'UNSPENT' as const }],
    };
  }

  async evidence() {
    return [
      {
        sequence: 1,
        operationId,
        source: 'durable_state' as const,
        event: 'proofs_persisted',
        dataHash: 'f'.repeat(64),
      },
    ];
  }
}

describe('cashu-ts lifecycle routes', () => {
  test('authenticates, validates, and redacts lifecycle operations', async () => {
    const lifecycle = new LifecycleOperations();
    const app = await buildCashuTsAdapterServer({
      now: () => 0,
      controlToken: 'lifecycle-control-token',
      lifecycle,
    });

    const unauthorized = await app.inject({ method: 'GET', url: '/v1/lifecycle/capabilities' });
    expect(unauthorized.statusCode).toBe(401);

    const token = 'cashuB-route-secret-token';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle/operations',
      headers: { authorization: 'Bearer lifecycle-control-token' },
      payload: { operationId, kind: 'receive', mint, unit: 'sat', token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ operationId, phase: 'ambiguous' });
    expect(response.body).not.toContain(token);
    expect(lifecycle.lastInput).toMatchObject({ token });

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle/operations',
      headers: { authorization: 'Bearer lifecycle-control-token' },
      payload: { operationId, kind: 'receive', mint, unit: 'sat', token, leaked: true },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.body).not.toContain(token);
    await app.close();
  });

  test('requires auth for lifecycle routes even in explicit test mode', async () => {
    const app = await buildCashuTsAdapterServer({
      now: () => 0,
      testMode: true,
      controlToken: 'lifecycle-control-token',
      lifecycle: new LifecycleOperations(),
    });

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/v1/lifecycle/capabilities',
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'GET',
      url: '/v1/lifecycle/capabilities',
      headers: { authorization: 'Bearer lifecycle-control-token' },
    });
    expect(authorized.statusCode).toBe(200);
    await app.close();
  });

  test('accepts receive tokens up to the lifecycle contract limit despite the global limit', async () => {
    const lifecycle = new LifecycleOperations();
    const app = await buildCashuTsAdapterServer({
      now: () => 0,
      controlToken: 'lifecycle-control-token',
      lifecycle,
    });
    const token = `cashuB-${'x'.repeat(20_000)}`;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle/operations',
      headers: { authorization: 'Bearer lifecycle-control-token' },
      payload: { operationId, kind: 'receive', mint, unit: 'sat', token },
    });

    expect(response.statusCode).toBe(200);
    expect(lifecycle.lastInput).toMatchObject({ token });
    await app.close();
  });

  test('serves the complete contract surface with validated responses', async () => {
    const app = await buildCashuTsAdapterServer({
      now: () => 0,
      controlToken: 'lifecycle-control-token',
      lifecycle: new LifecycleOperations(),
    });
    const auth = { authorization: 'Bearer lifecycle-control-token' };

    for (const [method, url, payload] of [
      ['GET', '/v1/lifecycle/capabilities'],
      ['POST', '/v1/lifecycle/reset', { seed: 'route-seed' }],
      ['POST', `/v1/lifecycle/operations/${operationId}/resume`],
      ['GET', `/v1/lifecycle/operations/${operationId}`],
      ['GET', '/v1/lifecycle/wallet'],
      ['GET', '/v1/lifecycle/evidence'],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: auth,
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200);
    }
    await app.close();
  });

  test('keeps the legacy resume body echo and rejects conflicting identities', async () => {
    const app = await buildCashuTsAdapterServer({
      now: () => 0,
      controlToken: 'lifecycle-control-token',
      lifecycle: new LifecycleOperations(),
    });
    const auth = { authorization: 'Bearer lifecycle-control-token' };

    const compatible = await app.inject({
      method: 'POST',
      url: `/v1/lifecycle/operations/${operationId}/resume`,
      headers: auth,
      payload: { operationId },
    });
    expect(compatible.statusCode).toBe(200);

    const conflicting = await app.inject({
      method: 'POST',
      url: `/v1/lifecycle/operations/${operationId}/resume`,
      headers: auth,
      payload: { operationId: 'BBBBBBBBBBBBBBBBBBBBBA' },
    });
    expect(conflicting.statusCode).toBe(409);
    await app.close();
  });

  test('rejects secret-bearing evidence responses without reflecting the secret', async () => {
    const lifecycle = new LifecycleOperations();
    const canary = 'secret-evidence-canary-never-return';
    lifecycle.evidence = async () =>
      [
        {
          sequence: 1,
          operationId,
          source: 'durable_state' as const,
          event: 'proofs_persisted',
          dataHash: 'f'.repeat(64),
          secret: canary,
        },
      ] as never;
    const app = await buildCashuTsAdapterServer({
      now: () => 0,
      controlToken: 'lifecycle-control-token',
      lifecycle,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/lifecycle/evidence',
      headers: { authorization: 'Bearer lifecycle-control-token' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(response.body).not.toContain(canary);
    await app.close();
  });
});
