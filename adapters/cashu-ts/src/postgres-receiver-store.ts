import { CryptoEnvelope, PostgresReceiverStore } from '@cashu-fault-lab/reference-receiver';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { TieredReceiverStore } from './funded-receiver-operations.js';

export interface ResettablePostgresReceiverStoreOptions {
  readonly pool: Pool;
  readonly envelope: CryptoEnvelope;
  readonly tenantId?: string;
}

export interface CreatePostgresReceiverStoreOptions {
  readonly connectionString: string;
  readonly envelopeKey: Uint8Array;
  readonly tenantId?: string;
  readonly maxConnections?: number;
}

const RESET_SQL =
  'TRUNCATE receipt_outbox, merchant_credits, proof_claims, deliveries, payment_requests RESTART IDENTITY CASCADE';

function tenantId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error('PostgreSQL receiver tenant ID is invalid');
  }
  return value;
}

function connectionString(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PostgreSQL connection string is invalid');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL connection string must use postgres:// or postgresql://');
  }
  if (url.hash.length > 0)
    throw new Error('PostgreSQL connection string cannot contain a fragment');
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 100) {
    throw new Error(`${name} must be an integer from 1 to 100`);
  }
  return result;
}

export async function migrateCashuTsReceiverDatabase(pool: Pool): Promise<void> {
  const migrationDirectory = fileURLToPath(new URL('../../../infra/migrations/', import.meta.url));
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    await pool.query(await readFile(join(migrationDirectory, migration), 'utf8'));
  }
}

export class ResettablePostgresReceiverStore
  extends PostgresReceiverStore
  implements TieredReceiverStore
{
  readonly receiverEvidenceTier = 'T3';
  readonly #pool: Pool;

  constructor(options: ResettablePostgresReceiverStoreOptions) {
    super(options.pool, options.envelope, tenantId(options.tenantId) ?? 'cashu-ts');
    this.#pool = options.pool;
  }

  async reset(): Promise<void> {
    await this.#pool.query(RESET_SQL);
  }
}

export async function createPostgresCashuTsReceiverStore(
  options: CreatePostgresReceiverStoreOptions,
): Promise<{ readonly pool: Pool; readonly store: ResettablePostgresReceiverStore }> {
  const pool = new Pool({
    connectionString: connectionString(options.connectionString),
    max: positiveInteger(options.maxConnections, 10, 'PostgreSQL max connections'),
  });
  try {
    await migrateCashuTsReceiverDatabase(pool);
    return {
      pool,
      store: new ResettablePostgresReceiverStore({
        pool,
        envelope: new CryptoEnvelope(options.envelopeKey),
        ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      }),
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}
