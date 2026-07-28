import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresCrashArmStore,
  migratePostgresCrashArmStore,
} from '../src/postgres-crash-arm-store.js';

describe.skipIf(process.env.CFL_POSTGRES_E2E !== '1')('PostgresCrashArmStore', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('cashu_fault_lab')
      .withUsername('cashu')
      .withPassword('cashu-test-password')
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
    await migratePostgresCrashArmStore(pool);
  }, 120_000);

  afterAll(async () => {
    pool?.on('error', () => {});
    await pool?.end();
    await container?.stop();
  }, 30_000);

  it('persists isolated arms and atomically consumes exactly one requested hit', async () => {
    if (pool === undefined) throw new Error('PostgreSQL pool did not start');
    const first = new PostgresCrashArmStore({ pool, tenantId: 'tenant-a' });
    const otherTenant = new PostgresCrashArmStore({ pool, tenantId: 'tenant-b' });
    const arm = {
      runId: 'run-a',
      component: 'sender' as const,
      boundary: 'sender_after_send_before_response' as const,
      occurrence: 3,
    };
    await first.arm(arm);
    await otherTenant.arm(arm);
    await first.arm({ ...arm, runId: 'run-b' });

    await expect(first.arm(arm)).rejects.toThrow('already exists');
    await expect(first.arm({ ...arm, boundary: 'receiver_before_mint_request' })).rejects.toThrow(
      'does not match',
    );
    await expect(first.hit(arm)).resolves.toBe(false);
    await expect(first.hit(arm)).resolves.toBe(false);
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => first.hit(arm)));
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    expect(await first.list('run-a')).toEqual([{ ...arm, hits: 3, consumed: true }]);
    expect(await first.list('run-b')).toEqual([
      { ...arm, runId: 'run-b', hits: 0, consumed: false },
    ]);
    expect(await otherTenant.list('run-a')).toEqual([{ ...arm, hits: 0, consumed: false }]);

    await first.reset('run-a');
    expect(await first.list('run-a')).toEqual([]);
    expect(await otherTenant.list('run-a')).toHaveLength(1);
    expect(await first.activeRun()).toBe('run-a');
    expect(await otherTenant.activeRun()).toBeUndefined();
  });
});
