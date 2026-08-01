import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as secureRandomBytes,
} from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type {
  CashuTsLifecycleCreateResult,
  CashuTsLifecycleStore,
  CashuTsStoredLifecycleOperation,
} from './types.js';

interface LifecycleRow extends QueryResultRow {
  readonly operation_id: string;
  readonly record_ciphertext: Buffer;
  readonly record_nonce: Buffer;
  readonly record_tag: Buffer;
}

export interface PostgresCashuTsLifecycleStoreOptions {
  readonly pool: Pool;
  readonly key: Uint8Array;
  readonly tenantId?: string;
  readonly runId?: string;
  readonly randomBytes?: (size: number) => Uint8Array;
}

type DatabaseConnection = Pool | PoolClient;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function scopedId(value: string | undefined, fallback: string, name: string): string {
  const selected = value ?? fallback;
  if (!ID_PATTERN.test(selected)) throw new Error(`${name} is invalid`);
  return selected;
}

function fingerprint(seed: string): string {
  return createHash('sha256')
    .update('cashu-fault-lab/cashu-ts-lifecycle-seed-v1\0')
    .update(seed)
    .digest('hex');
}

function sameIdentity(
  left: CashuTsStoredLifecycleOperation,
  right: CashuTsStoredLifecycleOperation,
): boolean {
  return (
    left.view.operationId === right.view.operationId &&
    left.view.kind === right.view.kind &&
    left.view.mint === right.view.mint &&
    left.view.unit === right.view.unit &&
    left.view.intentHash === right.view.intentHash
  );
}

export async function migratePostgresCashuTsLifecycleStore(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashu_lifecycle_runs (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      seed_fingerprint char(64) NOT NULL CHECK (seed_fingerprint ~ '^[0-9a-f]{64}$'),
      seed_ciphertext bytea NOT NULL CHECK (octet_length(seed_ciphertext) > 0),
      seed_nonce bytea NOT NULL CHECK (octet_length(seed_nonce) = 12),
      seed_tag bytea NOT NULL CHECK (octet_length(seed_tag) = 16),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS cashu_lifecycle_operations (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      operation_id char(22) NOT NULL,
      kind text NOT NULL CHECK (kind IN ('mint', 'swap', 'send', 'receive', 'melt', 'restore', 'reconcile')),
      mint text NOT NULL,
      unit text NOT NULL,
      intent_hash char(64) NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
      phase text NOT NULL CHECK (phase IN ('created', 'prepared', 'submitted', 'ambiguous', 'reconciling', 'succeeded', 'failed_definitive', 'recovery_blocked')),
      request_hash char(64) CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
      quote_hash char(64) CHECK (quote_hash IS NULL OR quote_hash ~ '^[0-9a-f]{64}$'),
      output_plan_hash char(64) CHECK (output_plan_hash IS NULL OR output_plan_hash ~ '^[0-9a-f]{64}$'),
      record_ciphertext bytea NOT NULL CHECK (octet_length(record_ciphertext) > 0),
      record_nonce bytea NOT NULL CHECK (octet_length(record_nonce) = 12),
      record_tag bytea NOT NULL CHECK (octet_length(record_tag) = 16),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, run_id, operation_id),
      FOREIGN KEY (tenant_id, run_id) REFERENCES cashu_lifecycle_runs (tenant_id, run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS cashu_lifecycle_effects (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      effect_id text NOT NULL,
      operation_id char(22) NOT NULL,
      data_hash char(64) NOT NULL CHECK (data_hash ~ '^[0-9a-f]{64}$'),
      PRIMARY KEY (tenant_id, run_id, effect_id),
      FOREIGN KEY (tenant_id, run_id, operation_id) REFERENCES cashu_lifecycle_operations (tenant_id, run_id, operation_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS cashu_lifecycle_proofs (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      proof_id char(64) NOT NULL CHECK (proof_id ~ '^[0-9a-f]{64}$'),
      operation_id char(22) NOT NULL,
      state text NOT NULL CHECK (state IN ('UNSPENT', 'PENDING', 'SPENT')),
      PRIMARY KEY (tenant_id, run_id, proof_id),
      FOREIGN KEY (tenant_id, run_id, operation_id) REFERENCES cashu_lifecycle_operations (tenant_id, run_id, operation_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS cashu_lifecycle_output_plans (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      output_plan_hash char(64) NOT NULL CHECK (output_plan_hash ~ '^[0-9a-f]{64}$'),
      operation_id char(22) NOT NULL,
      PRIMARY KEY (tenant_id, run_id, output_plan_hash),
      UNIQUE (tenant_id, run_id, operation_id, output_plan_hash),
      FOREIGN KEY (tenant_id, run_id, operation_id) REFERENCES cashu_lifecycle_operations (tenant_id, run_id, operation_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS cashu_lifecycle_recoverable
      ON cashu_lifecycle_operations (tenant_id, run_id, updated_at, operation_id)
      WHERE phase IN ('submitted', 'ambiguous', 'reconciling');
  `);
}

export class PostgresCashuTsLifecycleStore implements CashuTsLifecycleStore {
  readonly #pool: Pool;
  readonly #key: Buffer;
  readonly #tenantId: string;
  readonly #runId: string;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #transaction = new AsyncLocalStorage<PoolClient>();

  constructor(options: PostgresCashuTsLifecycleStoreOptions) {
    this.#pool = options.pool;
    this.#key = Buffer.from(options.key);
    if (this.#key.byteLength !== 32) throw new Error('Lifecycle state key must contain 32 bytes');
    this.#tenantId = scopedId(options.tenantId, 'cashu-ts', 'Lifecycle tenant ID');
    this.#runId = scopedId(options.runId, 'default', 'Lifecycle run ID');
    this.#randomBytes = options.randomBytes ?? secureRandomBytes;
  }

  async reset(seed: string): Promise<void> {
    if (seed.length === 0) throw new Error('Lifecycle seed is required');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${this.#tenantId}:${this.#runId}:lifecycle`,
      ]);
      await client.query(`DELETE FROM cashu_lifecycle_runs WHERE tenant_id = $1 AND run_id = $2`, [
        this.#tenantId,
        this.#runId,
      ]);
      const envelope = this.#encrypt('seed', seed);
      await client.query(
        `INSERT INTO cashu_lifecycle_runs (
           tenant_id, run_id, seed_fingerprint, seed_ciphertext, seed_nonce, seed_tag
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          this.#tenantId,
          this.#runId,
          fingerprint(seed),
          envelope.ciphertext,
          envelope.nonce,
          envelope.tag,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async create(operation: CashuTsStoredLifecycleOperation): Promise<CashuTsLifecycleCreateResult> {
    const envelope = this.#encrypt(operation.view.operationId, operation);
    const result = await this.#db().query(
      `INSERT INTO cashu_lifecycle_operations (
         tenant_id, run_id, operation_id, kind, mint, unit, intent_hash, phase,
         request_hash, quote_hash, output_plan_hash, record_ciphertext, record_nonce, record_tag
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (tenant_id, run_id, operation_id) DO NOTHING`,
      this.#values(operation, envelope),
    );
    const stored = await this.get(operation.view.operationId);
    if (stored === undefined) throw new Error('Lifecycle operation could not be journaled');
    if (!sameIdentity(stored, operation)) throw new Error('Lifecycle operation identity conflicts');
    return { created: result.rowCount === 1, operation: stored };
  }

  async get(operationId: string): Promise<CashuTsStoredLifecycleOperation | undefined> {
    const result = await this.#db().query<LifecycleRow>(
      `SELECT operation_id, record_ciphertext, record_nonce, record_tag
       FROM cashu_lifecycle_operations
       WHERE tenant_id = $1 AND run_id = $2 AND operation_id = $3`,
      [this.#tenantId, this.#runId, operationId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const operation = this.#decrypt(row.operation_id, row);
    if (operation.view.operationId !== row.operation_id) {
      throw new Error('Lifecycle operation identity conflicts');
    }
    return operation;
  }

  async put(operation: CashuTsStoredLifecycleOperation): Promise<void> {
    const envelope = this.#encrypt(operation.view.operationId, operation);
    const result = await this.#db().query(
      `UPDATE cashu_lifecycle_operations
       SET kind = $4, mint = $5, unit = $6, intent_hash = $7, phase = $8,
           request_hash = $9, quote_hash = $10, output_plan_hash = $11,
           record_ciphertext = $12, record_nonce = $13, record_tag = $14, updated_at = now()
       WHERE tenant_id = $1 AND run_id = $2 AND operation_id = $3 AND intent_hash = $7`,
      this.#values(operation, envelope),
    );
    if (result.rowCount !== 1) throw new Error('Lifecycle operation identity conflicts');
    if (operation.view.outputPlanHash !== undefined) {
      const plan = await this.#db().query(
        `INSERT INTO cashu_lifecycle_output_plans AS existing (
           tenant_id, run_id, output_plan_hash, operation_id
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, run_id, output_plan_hash) DO UPDATE
         SET output_plan_hash = EXCLUDED.output_plan_hash
         WHERE existing.operation_id = EXCLUDED.operation_id
         RETURNING operation_id`,
        [this.#tenantId, this.#runId, operation.view.outputPlanHash, operation.view.operationId],
      );
      if (plan.rowCount !== 1) throw new Error('Lifecycle output plan identity conflicts');
    }
  }

  async claim<T>(operationId: string, work: () => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT operation_id FROM cashu_lifecycle_operations
         WHERE tenant_id = $1 AND run_id = $2 AND operation_id = $3
         FOR UPDATE`,
        [this.#tenantId, this.#runId, operationId],
      );
      if (result.rowCount !== 1) throw new Error('Lifecycle operation was not found');
      const value = await this.#transaction.run(client, work);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  #db(): DatabaseConnection {
    return this.#transaction.getStore() ?? this.#pool;
  }

  #values(
    operation: CashuTsStoredLifecycleOperation,
    envelope: { readonly ciphertext: Buffer; readonly nonce: Buffer; readonly tag: Buffer },
  ): unknown[] {
    return [
      this.#tenantId,
      this.#runId,
      operation.view.operationId,
      operation.view.kind,
      operation.view.mint,
      operation.view.unit,
      operation.view.intentHash,
      operation.view.phase,
      operation.view.requestHash ?? null,
      operation.view.quoteHash ?? null,
      operation.view.outputPlanHash ?? null,
      envelope.ciphertext,
      envelope.nonce,
      envelope.tag,
    ];
  }

  #aad(identity: string): Buffer {
    return Buffer.from(
      JSON.stringify([
        'cashu-fault-lab/cashu-ts-lifecycle-state/v1',
        this.#tenantId,
        this.#runId,
        identity,
      ]),
      'utf8',
    );
  }

  #encrypt(
    identity: string,
    value: unknown,
  ): { readonly ciphertext: Buffer; readonly nonce: Buffer; readonly tag: Buffer } {
    const nonce = Buffer.from(this.#randomBytes(12));
    if (nonce.byteLength !== 12) throw new Error('Lifecycle state nonce must contain 12 bytes');
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(this.#aad(identity));
    const plaintext = Buffer.from(
      typeof value === 'string' ? value : JSON.stringify(value),
      'utf8',
    );
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, nonce, tag: cipher.getAuthTag() };
  }

  #decrypt(identity: string, row: LifecycleRow): CashuTsStoredLifecycleOperation {
    try {
      if (row.record_nonce.byteLength !== 12 || row.record_tag.byteLength !== 16) {
        throw new Error('invalid envelope dimensions');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.#key, row.record_nonce);
      decipher.setAAD(this.#aad(identity));
      decipher.setAuthTag(row.record_tag);
      const plaintext = Buffer.concat([
        decipher.update(row.record_ciphertext),
        decipher.final(),
      ]).toString('utf8');
      const parsed = JSON.parse(plaintext) as Partial<CashuTsStoredLifecycleOperation>;
      if (
        typeof parsed.input !== 'object' ||
        parsed.input === null ||
        typeof parsed.view !== 'object' ||
        parsed.view === null ||
        typeof parsed.view.operationId !== 'string'
      ) {
        throw new Error('invalid lifecycle record');
      }
      return parsed as CashuTsStoredLifecycleOperation;
    } catch {
      throw new Error('Unable to decrypt or authenticate lifecycle state');
    }
  }
}
