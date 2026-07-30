import {
  currentAdapterContract,
  developmentIdentity,
  type AdapterCapabilities,
} from '@cashu-fault-lab/adapter-contract';
import { describe, expect, it } from 'vitest';
import { parseAdapterManifest } from '../src/adapter-manifest.js';
import { preflightLocalAdapters } from '../src/adapter-preflight.js';

function capabilities(id = 'my-wallet'): AdapterCapabilities {
  return {
    schemaVersion: 2,
    contract: currentAdapterContract(),
    implementation: developmentIdentity({
      id,
      version: '0.1.0',
      language: 'typescript',
      runtime: 'node-24',
    }),
    roles: {
      sender: {
        transports: ['http'],
        profiles: ['delivery-v1'],
        durability: 'process',
        evidence: { tier: 'T1', sources: ['adapter'] },
      },
      receiver: {
        transports: ['http'],
        profiles: ['delivery-v1'],
        durability: 'process',
        evidence: { tier: 'T1', sources: ['adapter'] },
      },
    },
    nuts: [18],
    encodings: ['creqA'],
    mints: [],
  };
}

function manifest() {
  return parseAdapterManifest({
    schemaVersion: 2,
    adapters: [
      {
        id: 'my-wallet',
        url: 'http://127.0.0.1:4100',
        tokenEnv: 'MY_WALLET_TOKEN',
      },
    ],
  });
}

describe('local adapter preflight', () => {
  it('performs a read-only contract, identity, and profile check', async () => {
    const requests: Array<{ method: string; url: string; authorization: string | null }> = [];

    const report = await preflightLocalAdapters({
      manifest: manifest(),
      env: { MY_WALLET_TOKEN: 'local-secret' },
      profile: 'delivery-v1',
      fetch: async (input, init) => {
        requests.push({
          method: init?.method ?? 'GET',
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return Response.json(capabilities());
      },
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      ok: true,
      profile: 'delivery-v1',
      adapters: [
        {
          id: 'my-wallet',
          url: 'http://127.0.0.1:4100',
          implementation: { id: 'my-wallet', version: '0.1.0' },
        },
      ],
    });
    expect(report.checks.map(({ code, status }) => [code, status])).toEqual([
      ['ADAPTER_TOKEN_PRESENT', 'passed'],
      ['ADAPTER_REACHABLE', 'passed'],
      ['ADAPTER_IDENTITY_MATCH', 'passed'],
      ['ADAPTER_CONTRACT_COMPATIBLE', 'passed'],
      ['ADAPTER_PROFILE_SUPPORTED', 'passed'],
    ]);
    expect(requests).toEqual([
      {
        method: 'GET',
        url: 'http://127.0.0.1:4100/v1/capabilities',
        authorization: 'Bearer local-secret',
      },
    ]);
    expect(JSON.stringify(report)).not.toContain('local-secret');
  });

  it('reports stable actionable failures without exposing bearer values', async () => {
    const missingToken = await preflightLocalAdapters({
      manifest: manifest(),
      env: {},
      profile: 'delivery-v1',
    });
    expect(missingToken).toMatchObject({
      ok: false,
      checks: [
        {
          code: 'ADAPTER_TOKEN_MISSING',
          status: 'failed',
          adapterId: 'my-wallet',
          remediation: 'Set MY_WALLET_TOKEN and rerun adapter preflight.',
        },
      ],
    });

    const identityMismatch = await preflightLocalAdapters({
      manifest: manifest(),
      env: { MY_WALLET_TOKEN: 'do-not-print-this' },
      profile: 'delivery-v1',
      fetch: async () => Response.json(capabilities('another-wallet')),
    });
    expect(identityMismatch.ok).toBe(false);
    expect(identityMismatch.checks.at(-1)).toMatchObject({
      code: 'ADAPTER_IDENTITY_MISMATCH',
      status: 'failed',
      adapterId: 'my-wallet',
    });
    expect(JSON.stringify(identityMismatch)).not.toContain('do-not-print-this');
  });

  it('checks configured evidence authorities using only read operations', async () => {
    const configured = parseAdapterManifest({
      schemaVersion: 2,
      adapters: [
        {
          id: 'my-wallet',
          url: 'http://127.0.0.1:4100',
          tokenEnv: 'MY_WALLET_TOKEN',
          evidence: {
            ledger: { url: 'http://127.0.0.1:5101', tokenEnv: 'LEDGER_TOKEN' },
            mint: { url: 'http://127.0.0.1:5102', tokenEnv: 'MINT_TOKEN' },
          },
        },
      ],
    });
    const paths: string[] = [];

    const report = await preflightLocalAdapters({
      manifest: configured,
      env: {
        MY_WALLET_TOKEN: 'adapter-token',
        LEDGER_TOKEN: 'ledger-token',
        MINT_TOKEN: 'mint-token',
      },
      profile: 'delivery-v1',
      fetch: async (input) => {
        const url = String(input);
        paths.push(url);
        if (url.endsWith('/v1/capabilities')) return Response.json(capabilities());
        return Response.json([]);
      },
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map(({ code }) => code)).toContain('LEDGER_AUTHORITY_REACHABLE');
    expect(report.checks.map(({ code }) => code)).toContain('MINT_AUTHORITY_REACHABLE');
    expect(paths).toEqual([
      'http://127.0.0.1:4100/v1/capabilities',
      'http://127.0.0.1:5101/v1/ledger',
      'http://127.0.0.1:5102/v1/proofs',
      'http://127.0.0.1:5102/v1/redemptions',
    ]);
  });
});
