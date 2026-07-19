import type { ScenarioSpec } from '@cashu-fault-lab/scenario-runner';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
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
      services: { up: async (profile) => void profiles.push(profile) },
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
});
