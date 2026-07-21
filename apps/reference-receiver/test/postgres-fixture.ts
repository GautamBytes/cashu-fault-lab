import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

export interface PostgresFixture {
  readonly container: StartedPostgreSqlContainer;
  readonly pool: Pool;
}

export async function startPostgresFixture(): Promise<PostgresFixture> {
  const container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('cashu_fault_lab')
    .withUsername('cashu')
    .withPassword('cashu-test-password')
    .start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 30 });
  const migrationDirectory = fileURLToPath(new URL('../../../infra/migrations/', import.meta.url));
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    await pool.query(await readFile(join(migrationDirectory, migration), 'utf8'));
  }
  return { container, pool };
}

export async function resetPostgres(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE receipt_outbox, merchant_credits, proof_claims, deliveries, payment_requests RESTART IDENTITY CASCADE',
  );
}

export async function stopPostgresFixture(fixture: PostgresFixture): Promise<void> {
  // Pool.end() resolves before every underlying socket has fully drained its
  // close handshake. If we stop the container immediately, postgres terminates
  // the connections out from under us and pg emits uncaught 'error' events
  // (FATAL code 57P01) that vitest 4 surfaces as test-run failures. Attach a
  // no-op error listener before ending so late socket errors are swallowed,
  // then wait for the event loop to drain before tearing down the container.
  const swallowLateErrors = (): void => {
    // no-op: late connection errors between pool.end() and container.stop() are expected
  };
  fixture.pool.on('error', swallowLateErrors);
  await fixture.pool.end();
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  fixture.pool.off('error', swallowLateErrors);
  await fixture.container.stop();
}
