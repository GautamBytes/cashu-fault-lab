import type { ScenarioSpec } from '@cashu-fault-lab/scenario-runner';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { AdapterManifest } from '../src/adapter-manifest.js';
import { PackagedLabRuntime } from '../src/packaged-runtime.js';

async function scenario(path: string): Promise<ScenarioSpec> {
  return JSON.parse(
    await readFile(new URL(`../../../scenarios/${path}`, import.meta.url), 'utf8'),
  ) as ScenarioSpec;
}

describe('PackagedLabRuntime', () => {
  it('starts the selected compose profile through the packaged service controller', async () => {
    const profiles: string[] = [];
    const runtime = new PackagedLabRuntime({
      services: { up: async (profile) => void profiles.push(profile), down: async () => {} },
    });

    await runtime.up('lab');

    expect(profiles).toEqual(['lab']);
  });

  it('runs and replays the real HTTP response-loss lane', async () => {
    const runtime = new PackagedLabRuntime();
    const first = await runtime.run(await scenario('retry/response-lost.json'), 'packaged-http', {
      sender: 'reference-ts',
      receiver: 'reference-ts',
    });

    expect(first.status).toBe('passed');
    expect(
      first.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'merchant_credited',
      ),
    ).toHaveLength(1);
    expect(first.artifact.capabilities).toMatchObject({ evidenceTier: 'T0' });

    const replayed = await runtime.replay(first.artifact);
    expect(replayed.status).toBe('passed');
    expect(replayed.artifact.commands).toEqual(first.artifact.commands);
  });

  it('uses the seed for delivery evidence while preserving deterministic replay', async () => {
    const runtime = new PackagedLabRuntime();
    const spec = await scenario('retry/response-lost.json');
    const first = await runtime.run(spec, 'seed-a');
    const second = await runtime.run(spec, 'seed-b');
    const replayed = await runtime.run(spec, 'seed-a');
    const deliveryEvidence = (result: typeof first) =>
      result.artifact.history.find(
        (event) => event.phase === 'observation' && event.event === 'delivery_attempted',
      )?.data;

    expect(deliveryEvidence(first)).not.toEqual(deliveryEvidence(second));
    expect(deliveryEvidence(replayed)).toEqual(deliveryEvidence(first));
  });

  it('uses the matrix seed in reference probe evidence', async () => {
    const runtime = new PackagedLabRuntime();
    const evidence = async (seed: string) => {
      const results = await runtime.matrix('delivery-v1', seed);
      return results.find((result) => result.status === 'passed')?.evidence;
    };

    expect(await evidence('seed-a')).not.toEqual(await evidence('seed-b'));
    expect(await evidence('seed-a')).toEqual(await evidence('seed-a'));
  });

  it('allows a compose-only fault gateway token without enabling HTTP fault injection', async () => {
    const runtime = new PackagedLabRuntime({
      env: { CFL_HTTP_FAULT_GATEWAY_TOKEN: 'compose-only-fault-token' },
    });

    await expect(runtime.matrix('delivery-v1', 'compose-token')).resolves.toContainEqual(
      expect.objectContaining({
        sender: 'reference-ts',
        receiver: 'reference-ts',
        status: 'passed',
      }),
    );
  });

  it('executes discovered external sender and receiver adapters', async () => {
    const requestId = 'AAECAwQFBgcICQoLDA0ODw';
    const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
    let activeDeliveryId = deliveryId;
    const receipt = () =>
      ({
        profile: 'cashu-delivery-v1',
        request_id: requestId,
        delivery_id: activeDeliveryId,
        payload_hash: 'a'.repeat(64),
        status: 'settled',
        status_version: 2,
        mint: 'https://mint.example',
        unit: 'sat',
        amount: 8,
        detail_code: 'settled',
      }) as const;
    const manifest: AdapterManifest = {
      schemaVersion: 1,
      adapters: [
        { id: 'wallet-sender', url: 'http://127.0.0.1:4101', tokenEnv: 'SENDER_TOKEN' },
        { id: 'wallet-receiver', url: 'http://127.0.0.1:4102', tokenEnv: 'RECEIVER_TOKEN' },
      ],
    };
    const fetchCalls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      fetchCalls.push(`${url.port}${url.pathname}`);
      const sender = url.port === '4101';
      const body = (() => {
        if (url.pathname === '/v1/capabilities') {
          return {
            implementation: sender ? 'wallet-sender' : 'wallet-receiver',
            version: '1.0.0',
            nuts: [3, 7, 18],
            transports: ['http'],
            evidenceTier: 'T1',
            encodings: ['creqA'],
            profiles: [
              {
                name: 'delivery-v1',
                roles: [sender ? 'sender' : 'receiver'],
                status: 'supported',
              },
            ],
          };
        }
        if (url.pathname === '/v1/reset') return { ok: true };
        if (url.pathname === '/v1/requests') {
          return {
            id: requestId,
            raw: 'creqAexample',
            amount: 8,
            unit: 'sat',
            singleUse: true,
            expiresAt: 1_784_400_300,
            transports: [{ type: 'post', target: 'http://127.0.0.1:4102/pay' }],
          };
        }
        if (url.pathname === '/v1/send') {
          const input = JSON.parse(String(init?.body)) as { readonly deliveryId?: string };
          activeDeliveryId = input.deliveryId ?? activeDeliveryId;
          return receipt();
        }
        if (url.pathname.startsWith('/v1/deliveries/')) return receipt();
        if (url.pathname === '/v1/ledger') {
          return [
            {
              requestId,
              deliveryId: activeDeliveryId,
              amount: 8,
              unit: 'sat',
              creditCount: 1,
              createdAt: 1_784_399_401,
            },
          ];
        }
        if (url.pathname === '/v1/proofs') {
          return [
            {
              deliveryId: activeDeliveryId,
              proofSetHash: 'b'.repeat(64),
              inputYs: [`02${'01'.repeat(32)}`],
              state: 'spent',
            },
          ];
        }
        throw new Error(`Unexpected adapter request: ${url.pathname} ${String(init?.method)}`);
      })();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const runtime = new PackagedLabRuntime({
      env: { SENDER_TOKEN: 'sender-secret', RECEIVER_TOKEN: 'receiver-secret' },
      fetch: fakeFetch,
    });

    const results = await runtime.matrix('delivery-v1', 'external-seed', manifest);

    expect(results).toContainEqual({
      profile: 'delivery-v1',
      sender: 'wallet-sender',
      receiver: 'wallet-receiver',
      status: 'passed',
      evidence: expect.objectContaining({ tier: 'T1', credits: 1, seed: 'external-seed' }),
    });
    expect(fetchCalls).toContain('4101/v1/send');
    expect(fetchCalls).toContain(`4102/v1/deliveries/${deliveryId}`);

    const scenarioResult = await runtime.run(
      {
        name: 'external-direct',
        commands: [
          { type: 'send', sender: 'logical-sender', requestId: 'logical-request' },
          { type: 'assert_quiescent' },
        ],
      },
      'external-scenario-seed',
      {
        sender: 'wallet-sender',
        receiver: 'wallet-receiver',
        adapterManifest: manifest,
      },
    );
    expect(scenarioResult.status).toBe('passed');
    expect(scenarioResult.artifact.capabilities).toMatchObject({ evidenceTier: 'T1' });
  });

  it('maps external restart commands to the selected adapter services', async () => {
    const requestId = 'AAECAwQFBgcICQoLDA0ODw';
    let activeDeliveryId = 'EBESExQVFhcYGRobHB0eHw';
    const receipt = () =>
      ({
        profile: 'cashu-delivery-v1',
        request_id: requestId,
        delivery_id: activeDeliveryId,
        payload_hash: 'a'.repeat(64),
        status: 'settled',
        status_version: 2,
        mint: 'https://mint.example',
        unit: 'sat',
        amount: 8,
        detail_code: 'settled',
      }) as const;
    const manifest: AdapterManifest = {
      schemaVersion: 1,
      adapters: [
        { id: 'wallet-sender', url: 'http://127.0.0.1:4101', tokenEnv: 'SENDER_TOKEN' },
        { id: 'wallet-receiver', url: 'http://127.0.0.1:4102', tokenEnv: 'RECEIVER_TOKEN' },
      ],
    };
    const restarted: string[] = [];
    const services = {
      up: async () => {},
      down: async () => {},
      restart: async (serviceId: string) => void restarted.push(serviceId),
    };
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const sender = url.port === '4101';
      const body = (() => {
        if (url.pathname === '/v1/capabilities') {
          return {
            implementation: sender ? 'wallet-sender' : 'wallet-receiver',
            version: '1.0.0',
            nuts: [3, 7, 18],
            transports: ['http'],
            evidenceTier: 'T1',
            encodings: ['creqA'],
            profiles: [
              {
                name: 'delivery-v1',
                roles: [sender ? 'sender' : 'receiver'],
                status: 'supported',
              },
            ],
          };
        }
        if (url.pathname === '/v1/reset') return { ok: true };
        if (url.pathname === '/v1/requests') {
          return {
            id: requestId,
            raw: 'creqAexample',
            amount: 8,
            unit: 'sat',
            singleUse: true,
            expiresAt: 1_784_400_300,
            transports: [{ type: 'post', target: 'http://127.0.0.1:4102/pay' }],
          };
        }
        if (url.pathname === '/v1/send') {
          const input = JSON.parse(String(init?.body)) as { readonly deliveryId?: string };
          activeDeliveryId = input.deliveryId ?? activeDeliveryId;
          return receipt();
        }
        if (url.pathname.startsWith('/v1/deliveries/')) return receipt();
        if (url.pathname === '/v1/ledger') {
          return [
            {
              requestId,
              deliveryId: activeDeliveryId,
              amount: 8,
              unit: 'sat',
              creditCount: 1,
              createdAt: 1_784_399_401,
            },
          ];
        }
        if (url.pathname === '/v1/proofs') {
          return [
            {
              deliveryId: activeDeliveryId,
              proofSetHash: 'b'.repeat(64),
              inputYs: [`02${'01'.repeat(32)}`],
              state: 'spent',
            },
          ];
        }
        throw new Error(`Unexpected adapter request: ${url.pathname} ${String(init?.method)}`);
      })();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const runtime = new PackagedLabRuntime({
      services,
      env: { SENDER_TOKEN: 'sender-secret', RECEIVER_TOKEN: 'receiver-secret' },
      fetch: fakeFetch,
    });

    const result = await runtime.run(
      {
        name: 'external-restart-plumbing',
        commands: [
          { type: 'send', sender: 'logical-sender', requestId: 'logical-request' },
          { type: 'restart', component: 'receiver' },
          { type: 'restart', component: 'sender' },
          { type: 'send', sender: 'logical-sender', requestId: 'logical-request' },
          { type: 'assert_quiescent' },
        ],
      },
      'external-restart-seed',
      {
        sender: 'wallet-sender',
        receiver: 'wallet-receiver',
        adapterManifest: manifest,
      },
    );

    if (result.status === 'failed') throw new Error(result.error.message);
    expect(result.status).toBe('passed');
    expect(restarted).toEqual(['wallet-receiver', 'wallet-sender']);
  });

  it('fails closed for adapters without a runnable delivery-v1 profile', async () => {
    const runtime = new PackagedLabRuntime();
    const result = await runtime.run(await scenario('retry/response-lost.json'), 'unsupported', {
      sender: 'cashu-ts',
      receiver: 'reference-ts',
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/unsupported adapter pair/i) },
    });
  });

  it.each(['retry/nostr-response-lost.json', 'retry/cross-transport-fallback.json'])(
    'runs real NIP-17 lane %s with one credit',
    async (path) => {
      const runtime = new PackagedLabRuntime();
      const result = await runtime.run(await scenario(path), `packaged:${path}`);

      expect(result.status).toBe('passed');
      expect(
        result.artifact.history.filter(
          (event) => event.phase === 'observation' && event.event === 'merchant_credited',
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    'retry/nostr-response-lost.json',
    'retry/cross-transport-fallback.json',
    'crash-recovery/mint-response-lost.json',
  ])('uses the seed in %s delivery evidence', async (path) => {
    const runtime = new PackagedLabRuntime();
    const spec = await scenario(path);
    const first = await runtime.run(spec, 'seed-a');
    const second = await runtime.run(spec, 'seed-b');
    const attempted = (result: typeof first) =>
      result.artifact.history.find(
        (event) => event.phase === 'observation' && event.event === 'delivery_attempted',
      )?.data;

    expect(first.status).toBe('passed');
    expect(second.status).toBe('passed');
    expect(attempted(first)).not.toEqual(attempted(second));
  });

  it('recovers mint commit-then-timeout across receiver restart', async () => {
    const runtime = new PackagedLabRuntime();
    const result = await runtime.run(
      await scenario('crash-recovery/mint-response-lost.json'),
      'packaged-crash',
    );

    expect(result.status).toBe('passed');
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'merchant_credited',
      ),
    ).toHaveLength(1);
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'completed' && event.event === 'restart',
      ),
    ).toHaveLength(1);
  });

  it('recovers across receiver restart mid-swap with one credit and one redemption', async () => {
    const runtime = new PackagedLabRuntime();
    const result = await runtime.run(
      await scenario('crash-recovery/receiver-restart-mid-swap.json'),
      'packaged-receiver-restart',
    );

    expect(result.status).toBe('passed');
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'merchant_credited',
      ),
    ).toHaveLength(1);
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'redemption_started',
      ),
    ).toHaveLength(1);
  });

  it('recovers across sender restart mid-delivery with one credit and no second swap', async () => {
    const runtime = new PackagedLabRuntime();
    const result = await runtime.run(
      await scenario('crash-recovery/sender-restart-mid-delivery.json'),
      'packaged-sender-restart',
    );

    expect(result.status).toBe('passed');
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'merchant_credited',
      ),
    ).toHaveLength(1);
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'redemption_started',
      ),
    ).toHaveLength(1);
    const restarts = result.artifact.history.filter(
      (event) => event.phase === 'completed' && event.event === 'restart',
    );
    expect(restarts).toHaveLength(2);
    const restarted = (value: unknown): unknown =>
      typeof value === 'object' && value !== null ? Reflect.get(value, 'restarted') : undefined;
    expect(restarts.map((event) => restarted(event.data)).sort()).toEqual(['receiver', 'sender']);
  });

  it('recovers a lost mint response through an active NUT-19 cache hit', async () => {
    const result = await new PackagedLabRuntime().run(
      await scenario('crash-recovery/nut19-cache-hit-recovery.json'),
      'packaged-nut19',
    );

    expect(result.status).toBe('passed');
    expect(result.artifact.componentVersions).toMatchObject({
      'lab-cli': '0.0.0',
      'scenario-runner': '0.0.0',
    });
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'merchant_credited',
      ),
    ).toHaveLength(1);
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'redemption_started',
      ),
    ).toHaveLength(1);
  });

  it.each([
    'security/redirect-leak.json',
    'security/ssrf.json',
    'security/cors.json',
    'security/malformed-input.json',
  ])('runs security lane %s without payment leakage', async (path) => {
    const result = await new PackagedLabRuntime().run(await scenario(path), `packaged:${path}`);

    expect(result.status).toBe('passed');
    expect(result.artifact.capabilities).toMatchObject({ securityProbe: path.split('/')[1] });
    expect(JSON.stringify(result.artifact)).not.toMatch(/Bearer\s+\S+|packaged-.*-proof/);
  });

  it('converges 100 cross-transport duplicates on one merchant credit', async () => {
    const result = await new PackagedLabRuntime().run(
      await scenario('concurrency/cross-transport-storm.json'),
      'packaged-cross-storm',
    );

    expect(result.status).toBe('passed');
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'merchant_credited',
      ),
    ).toHaveLength(1);
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'delivery_attempted',
      ),
    ).toHaveLength(2);
  });

  it('rejects a delivery as expired after virtual time advances past the validity window', async () => {
    const result = await new PackagedLabRuntime().run(
      await scenario('conformance/created-expired.json'),
      'packaged-expiry',
    );

    expect(result.status).toBe('passed');
    const receipt = result.artifact.history.find(
      (event) => event.phase === 'observation' && event.event === 'receipt_observed',
    )?.data;
    expect(receipt).toMatchObject({ status: 'rejected', detailCode: 'expired' });
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'redemption_started',
      ),
    ).toHaveLength(0);
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'merchant_credited',
      ),
    ).toHaveLength(0);
  });

  it.each([
    ['conformance/conflict-delivery.json', 'DELIVERY_CONFLICT'],
    ['conformance/conflict-proof.json', 'PROOF_CONFLICT'],
    ['conformance/conflict-single-use.json', 'SINGLE_USE_CONFLICT'],
  ])('rejects conformance conflict lane %s without second settlement', async (path, code) => {
    const result = await new PackagedLabRuntime().run(await scenario(path), `packaged:${path}`);

    expect(result.status).toBe('passed');
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'merchant_credited',
      ),
    ).toHaveLength(1);
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'redemption_started',
      ),
    ).toHaveLength(1);
    const completions = result.artifact.history.filter(
      (event) => event.phase === 'completed' && event.event === 'send',
    );
    const outcome = completions[1]?.data;
    const rejectedCode =
      typeof outcome === 'object' && outcome !== null ? Reflect.get(outcome, 'rejectedCode') : '';
    expect(rejectedCode).toBe(code);
  });

  it('shrinks a failing artifact to a smaller reproducing command set', async () => {
    const runtime = new PackagedLabRuntime();
    const spec: ScenarioSpec = {
      name: 'unsupported-shrink-target',
      commands: [
        { type: 'assert_quiescent' },
        { type: 'send', sender: 'reference', requestId: 'AAECAwQFBgcICQoLDA0ODw' },
        { type: 'assert_quiescent' },
      ],
    };
    const baseline = await runtime.run(spec, 'shrink-seed');

    expect(baseline.status).toBe('failed');
    if (baseline.status !== 'failed') throw new Error('expected failure');
    expect(baseline.error.message).toMatch(/unsupported packaged scenario/i);

    const minimized = await runtime.shrink(baseline.artifact);

    expect(minimized.status).toBe('failed');
    if (minimized.status !== 'failed') throw new Error('expected failure');
    expect(minimized.error.name).toBe(baseline.error.name);
    expect(minimized.error.message).toBe(baseline.error.message);
    expect(minimized.artifact.commands.length).toBeLessThan(spec.commands.length);
  });

  it('refuses to shrink an artifact that no longer reproduces a failure', async () => {
    const runtime = new PackagedLabRuntime();
    const passing = await runtime.run(await scenario('retry/response-lost.json'), 'shrink-passing');

    expect(passing.status).toBe('passed');
    await expect(runtime.shrink(passing.artifact)).rejects.toThrow(/cannot be minimized/i);
  });
});
