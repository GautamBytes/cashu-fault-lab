import { describe, expect, it } from 'vitest';
import { parseAdapterManifest, resolveAdapterManifest } from '../src/adapter-manifest.js';

describe('adapter manifest', () => {
  it('parses loopback adapters and resolves control tokens from the environment', () => {
    const manifest = parseAdapterManifest({
      schemaVersion: 2,
      adapters: [
        {
          id: 'cashu-ts',
          url: 'http://127.0.0.1:4101',
          tokenEnv: 'CFL_CASHU_TS_TOKEN',
          evidence: {
            ledger: {
              url: 'http://127.0.0.1:5101',
              tokenEnv: 'CFL_LEDGER_EVIDENCE_TOKEN',
            },
            mint: {
              url: 'http://127.0.0.1:5102',
              tokenEnv: 'CFL_MINT_EVIDENCE_TOKEN',
            },
          },
        },
      ],
    });

    expect(
      resolveAdapterManifest(manifest, {
        CFL_CASHU_TS_TOKEN: 'token-a',
        CFL_LEDGER_EVIDENCE_TOKEN: 'ledger-token',
        CFL_MINT_EVIDENCE_TOKEN: 'mint-token',
      }),
    ).toEqual([
      {
        id: 'cashu-ts',
        url: 'http://127.0.0.1:4101',
        token: 'token-a',
        evidence: {
          ledger: { url: 'http://127.0.0.1:5101', token: 'ledger-token' },
          mint: { url: 'http://127.0.0.1:5102', token: 'mint-token' },
        },
      },
    ]);
  });

  it.each([
    { schemaVersion: 3, adapters: [] },
    { schemaVersion: 1, adapters: [] },
    {
      schemaVersion: 1,
      adapters: [{ id: 'Uppercase', url: 'http://127.0.0.1:4101', tokenEnv: 'TOKEN' }],
    },
    {
      schemaVersion: 1,
      adapters: [{ id: 'wallet', url: 'https://wallet.example', tokenEnv: 'TOKEN' }],
    },
    {
      schemaVersion: 1,
      adapters: [
        {
          id: 'wallet',
          url: 'http://127.0.0.1:4101',
          tokenEnv: 'TOKEN',
          extra: true,
        },
      ],
    },
  ])('rejects unsafe or non-canonical manifest %#', (value) => {
    expect(() => parseAdapterManifest(value)).toThrow(/adapter manifest/i);
  });

  it('rejects URLs that can leak tokens outside the configured loopback origin', () => {
    for (const url of [
      'http://localhost:4101/path',
      'http://127.0.0.1:4101?query=yes',
      'http://127.0.0.1:4101/#fragment',
      'http://user:password@127.0.0.1:4101',
      'http://0.0.0.0:4101',
    ]) {
      expect(() =>
        parseAdapterManifest({
          schemaVersion: 1,
          adapters: [{ id: 'wallet', url, tokenEnv: 'TOKEN' }],
        }),
      ).toThrow(/adapter manifest/i);
    }
  });

  it('rejects duplicate adapter IDs', () => {
    expect(() =>
      parseAdapterManifest({
        schemaVersion: 1,
        adapters: [
          { id: 'wallet', url: 'http://127.0.0.1:4101', tokenEnv: 'TOKEN_A' },
          { id: 'wallet', url: 'http://127.0.0.1:4102', tokenEnv: 'TOKEN_B' },
        ],
      }),
    ).toThrow(/duplicate adapter id/i);
  });

  it('rejects invalid token variable names and missing tokens', () => {
    expect(() =>
      parseAdapterManifest({
        schemaVersion: 1,
        adapters: [{ id: 'wallet', url: 'http://127.0.0.1:4101', tokenEnv: 'not-valid' }],
      }),
    ).toThrow(/adapter manifest/i);

    const manifest = parseAdapterManifest({
      schemaVersion: 1,
      adapters: [{ id: 'wallet', url: 'http://127.0.0.1:4101', tokenEnv: 'WALLET_TOKEN' }],
    });
    expect(() => resolveAdapterManifest(manifest, {})).toThrow(/WALLET_TOKEN/);
    expect(() => resolveAdapterManifest(manifest, { WALLET_TOKEN: '' })).toThrow(/WALLET_TOKEN/);
  });

  it('rejects evidence authorities that alias the adapter control origin', () => {
    expect(() =>
      parseAdapterManifest({
        schemaVersion: 2,
        adapters: [
          {
            id: 'wallet',
            url: 'http://127.0.0.1:4101',
            tokenEnv: 'WALLET_TOKEN',
            evidence: {
              ledger: { url: 'http://127.0.0.1:4101', tokenEnv: 'LEDGER_TOKEN' },
            },
          },
        ],
      }),
    ).toThrow(/independent/i);
  });

  it('requires every configured evidence authority token', () => {
    const manifest = parseAdapterManifest({
      schemaVersion: 2,
      adapters: [
        {
          id: 'wallet',
          url: 'http://127.0.0.1:4101',
          tokenEnv: 'WALLET_TOKEN',
          evidence: {
            ledger: { url: 'http://127.0.0.1:5101', tokenEnv: 'LEDGER_TOKEN' },
          },
        },
      ],
    });

    expect(() =>
      resolveAdapterManifest(manifest, { WALLET_TOKEN: 'wallet-token' }),
    ).toThrow(/LEDGER_TOKEN/);
  });
});
