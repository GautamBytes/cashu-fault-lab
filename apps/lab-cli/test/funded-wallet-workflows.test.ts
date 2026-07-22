import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('funded wallet workflow targets', () => {
  it('runs the external funded wallet matrix as a fail-closed CI lane', async () => {
    const contents = await readFile(
      new URL('../../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );

    expect(contents).toContain('infra/compose/wallet-adapters.compose.yml');
    expect(contents).toContain('spec/examples/adapters.local.json');
    expect(contents).toContain('CFL_CASHU_TS_TOKEN');
    expect(contents).toContain('CFL_CDK_TOKEN');
    expect(contents).toContain('CFL_REFERENCE_RECEIVER_TOKEN');
    expect(contents).toContain('CFL_HTTP_FAULT_GATEWAY_TOKEN');
    expect(contents).toContain('CFL_HTTP_FAULT_GATEWAY_URL');
    expect(contents).toContain('matrix --profile delivery-v1');
    expect(contents).toContain('--min-passes 2');
  });

  it('exercises an external adapter restart scenario in CI', async () => {
    const contents = await readFile(
      new URL('../../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );

    expect(contents).toContain(
      'scenarios/crash-recovery/external-receiver-restart-after-settlement.json',
    );
    expect(contents).toContain('--sender cdk');
    expect(contents).toContain('--receiver cashu-ts');
    expect(contents).toContain('--adapters spec/examples/adapters.local.json');
  });

  it('mounts the cashu-ts Postgres 18 volume at the supported data root', async () => {
    const contents = await readFile(
      new URL('../../../infra/compose/wallet-adapters.compose.yml', import.meta.url),
      'utf8',
    );

    expect(contents).toContain('cashu-fault-lab-cashu-ts-postgres:/var/lib/postgresql');
    expect(contents).not.toContain('cashu-fault-lab-cashu-ts-postgres:/var/lib/postgresql/data');
  });

  it('promotes cashu-ts PostgreSQL and Nostr E2Es into scheduled CI', async () => {
    const contents = await readFile(
      new URL('../../../.github/workflows/nightly.yml', import.meta.url),
      'utf8',
    );

    expect(contents).toContain('CFL_POSTGRES_E2E');
    expect(contents).toContain('test/postgres-receiver-store.test.ts');
    expect(contents).toContain('CFL_NOSTR_RELAY_E2E');
    expect(contents).toContain('test/nostr-relay-e2e.test.ts');
  });
});
