import { describe, expect, it } from 'vitest';
import { parseAdapterManifest } from '../src/adapter-manifest.js';
import { ExternalAdapterRegistry } from '../src/adapter-registry.js';

function capability(implementation: string, version: string) {
  return {
    implementation,
    version,
    nuts: [18],
    transports: ['http'],
    evidenceTier: 'T1',
    encodings: ['creqA'],
    profiles: [{ name: 'delivery-v1', roles: ['sender', 'receiver'], status: 'supported' }],
  } as const;
}

describe('ExternalAdapterRegistry', () => {
  it('discovers contract-validated capabilities in manifest order', async () => {
    const manifest = parseAdapterManifest({
      schemaVersion: 1,
      adapters: [
        { id: 'cashu-ts', url: 'http://127.0.0.1:4101', tokenEnv: 'CASHU_TOKEN' },
        { id: 'cdk', url: 'http://127.0.0.1:4102', tokenEnv: 'CDK_TOKEN' },
      ],
    });
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const responses = new Map([
      ['http://127.0.0.1:4101', capability('cashu-ts', '4.7.2')],
      ['http://127.0.0.1:4102', capability('cdk', '0.17.3')],
    ]);
    const registry = await ExternalAdapterRegistry.load(
      manifest,
      { CASHU_TOKEN: 'token-a', CDK_TOKEN: 'token-b' },
      {
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const headers = new Headers(init?.headers);
          seen.push({ url: url.href, authorization: headers.get('authorization') });
          return new Response(JSON.stringify(responses.get(url.origin)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );

    expect(registry.ids()).toEqual(['cashu-ts', 'cdk']);
    expect(registry.participants()).toEqual([
      { id: 'cashu-ts', capabilities: capability('cashu-ts', '4.7.2') },
      { id: 'cdk', capabilities: capability('cdk', '0.17.3') },
    ]);
    expect(registry.client('cashu-ts')).toBeDefined();
    expect(registry.client('missing')).toBeUndefined();
    expect(seen).toEqual([
      { url: 'http://127.0.0.1:4101/v1/capabilities', authorization: 'Bearer token-a' },
      { url: 'http://127.0.0.1:4102/v1/capabilities', authorization: 'Bearer token-b' },
    ]);
  });

  it('rejects an adapter whose declared implementation differs from its manifest identity', async () => {
    const manifest = parseAdapterManifest({
      schemaVersion: 1,
      adapters: [{ id: 'cdk', url: 'http://127.0.0.1:4102', tokenEnv: 'CDK_TOKEN' }],
    });

    await expect(
      ExternalAdapterRegistry.load(
        manifest,
        { CDK_TOKEN: 'token' },
        {
          fetch: async () =>
            new Response(JSON.stringify(capability('cashu-ts', '4.7.2')), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        },
      ),
    ).rejects.toThrow(/identity/i);
  });
});
