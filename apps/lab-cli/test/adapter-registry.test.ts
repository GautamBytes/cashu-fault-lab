import { describe, expect, it } from 'vitest';
import { parseAdapterManifest } from '../src/adapter-manifest.js';
import { ExternalAdapterRegistry } from '../src/adapter-registry.js';

function capability(implementation: string, version: string): AdapterCapabilities {
  return {
    schemaVersion: 2,
    implementation: developmentIdentity({
      id: implementation,
      version,
      language: implementation === 'cdk' ? 'rust' : 'typescript',
      runtime: implementation === 'cdk' ? 'native' : 'node-24',
    }),
    roles: {
      sender: {
        transports: ['http'],
        profiles: ['delivery-v1'],
        durability: 'persistent',
        evidence: { tier: 'T1', sources: ['adapter'] },
      },
      receiver: {
        transports: ['http'],
        profiles: ['delivery-v1'],
        durability: 'persistent',
        evidence: { tier: 'T1', sources: ['adapter'] },
      },
    },
    nuts: [18],
    encodings: ['creqA'],
    mints: [],
  };
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

  it('exposes narrow read-only clients for independent ledger and mint authorities', async () => {
    const manifest = parseAdapterManifest({
      schemaVersion: 2,
      adapters: [
        {
          id: 'cashu-ts',
          url: 'http://127.0.0.1:4101',
          tokenEnv: 'CASHU_TOKEN',
          evidence: {
            ledger: { url: 'http://127.0.0.1:5101', tokenEnv: 'LEDGER_TOKEN' },
            mint: { url: 'http://127.0.0.1:5102', tokenEnv: 'MINT_TOKEN' },
          },
        },
      ],
    });
    const seen: string[] = [];
    const registry = await ExternalAdapterRegistry.load(
      manifest,
      {
        CASHU_TOKEN: 'adapter-token',
        LEDGER_TOKEN: 'ledger-token',
        MINT_TOKEN: 'mint-token',
      },
      {
        fetch: async (input) => {
          const url = String(input);
          seen.push(url);
          if (url.endsWith('/v1/capabilities')) {
            return Response.json(capability('cashu-ts', '4.7.2'));
          }
          if (url.endsWith('/v1/ledger')) return Response.json([]);
          if (url.endsWith('/v1/proofs')) return Response.json([]);
          return new Response(null, { status: 404 });
        },
      },
    );

    await expect(registry.evidence('cashu-ts')?.ledger?.ledger()).resolves.toEqual([]);
    await expect(registry.evidence('cashu-ts')?.mint?.proofs()).resolves.toEqual([]);
    expect(seen).toEqual([
      'http://127.0.0.1:4101/v1/capabilities',
      'http://127.0.0.1:5101/v1/ledger',
      'http://127.0.0.1:5102/v1/proofs',
    ]);
  });
});
import { developmentIdentity, type AdapterCapabilities } from '@cashu-fault-lab/adapter-contract';
