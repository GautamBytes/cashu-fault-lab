import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const composeUrl = new URL('../../../infra/compose/wallet-lifecycle.compose.yml', import.meta.url);

describe('wallet lifecycle funded environment contract', () => {
  it('pins two fake-value mints and exposes four isolated wallet/mint combinations', async () => {
    const compose = await readFile(composeUrl, 'utf8');

    expect(compose).toMatch(/cashubtc\/nutshell:0\.20\.2@sha256:[a-f0-9]{64}/u);
    expect(compose).toMatch(/cashubtc\/mintd:0\.17\.3@sha256:[a-f0-9]{64}/u);
    for (const service of ['cashu-ts-nutshell', 'cashu-ts-mintd', 'cdk-nutshell', 'cdk-mintd']) {
      expect(compose).toMatch(new RegExp(`^  ${service}:$`, 'mu'));
    }
    for (const volume of [
      'cashu-ts-nutshell-postgres',
      'cashu-ts-mintd-postgres',
      'cdk-nutshell-state',
      'cdk-mintd-state',
      'nutshell-state',
      'mintd-state',
    ]) {
      expect(compose).toMatch(new RegExp(`^  ${volume}:$`, 'mu'));
    }
    expect(
      compose.match(/127\.0\.0\.1:\$\{CFL_LIFECYCLE_(?:CASHU_TS|CDK)_[A-Z0-9_]+_PORT/gmu),
    ).toHaveLength(4);
    expect(compose).not.toMatch(/^\s+- ['"]?\d+:/mu);
  });

  it('enables authenticated lifecycle state and health checks for each adapter', async () => {
    const compose = await readFile(composeUrl, 'utf8');

    expect(compose.match(/\/v1\/(?:lifecycle\/)?capabilities/gmu)).toHaveLength(4);
    expect(compose.match(/LIFECYCLE_STATE_KEY:/gmu)).toHaveLength(4);
    expect(compose.match(/LIFECYCLE_DATABASE_(?:URL|PATH):/gmu)).toHaveLength(4);
    expect(compose.match(/condition: service_healthy/gmu)?.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(compose).toContain('CFL_HTTP_FAULT_GATEWAY_CONTROL_TOKEN');
    expect(compose).toContain('CASHU_FAULT_LAB_CONTROL_TOKEN');
  });
});
