import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { SenderDeliveryRecord, SenderState, SenderStateOperations } from './state.js';

interface SenderDeliveryRow extends QueryResultRow {
  readonly delivery_id: string;
  readonly record_ciphertext: Buffer;
  readonly record_nonce: Buffer;
  readonly record_tag: Buffer;
}

interface SerializedSenderDeliveryRecord extends Omit<SenderDeliveryRecord, 'payloadBytes'> {
  readonly payloadBytes: string;
}

export interface PostgresSenderStateOptions {
  readonly pool: Pool;
  readonly encryptionKey: Uint8Array;
  readonly tenantId?: string;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface CreatePostgresSenderStateOptions {
  readonly connectionString: string;
  readonly encryptionKey: Uint8Array;
  readonly tenantId?: string;
  readonly maxConnections?: number;
}

type DatabaseConnection = Pool | PoolClient;

const senderLockScope = new AsyncLocalStorage<boolean>();

function tenantId(value: string | undefined): string {
  const selected = value ?? 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(selected)) {
    throw new Error('PostgreSQL sender tenant ID is invalid');
  }
  return selected;
}

function encryptionKey(value: Uint8Array): Buffer {
  if (value.byteLength !== 32) {
    throw new Error('PostgreSQL sender encryption key must be 32 bytes');
  }
  return Buffer.from(value);
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
  if (url.hash.length > 0) {
    throw new Error('PostgreSQL connection string cannot contain a fragment');
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 100) {
    throw new Error(`${name} must be an integer from 1 to 100`);
  }
  return result;
}

function databaseErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = Reflect.get(value, 'code');
  return typeof code === 'string' ? code : undefined;
}

function authenticatedData(tenant: string, deliveryId: string): Buffer {
  return Buffer.from(`cashu-fault-lab/postgres-sender-state-v1\0${tenant}\0${deliveryId}`, 'utf8');
}

function serializeRecord(record: SenderDeliveryRecord): Buffer {
  const serialized: SerializedSenderDeliveryRecord = {
    ...record,
    payloadBytes: Buffer.from(record.payloadBytes).toString('base64url'),
  };
  return Buffer.from(JSON.stringify(serialized), 'utf8');
}

function deserializeRecord(value: Buffer): SenderDeliveryRecord {
  const parsed = JSON.parse(value.toString('utf8')) as Partial<SerializedSenderDeliveryRecord>;
  if (typeof parsed.payloadBytes !== 'string') {
    throw new Error('PostgreSQL sender record payload bytes are invalid');
  }
  return {
    ...(parsed as Omit<SerializedSenderDeliveryRecord, 'payloadBytes'>),
    payloadBytes: Uint8Array.from(Buffer.from(parsed.payloadBytes, 'base64url')),
  };
}

export async function migratePostgresSenderState(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sender_deliveries (
      tenant_id text NOT NULL,
      delivery_id text NOT NULL,
      record_ciphertext bytea NOT NULL,
      record_nonce bytea NOT NULL,
      record_tag bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, delivery_id)
    )
  `);
}

export class PostgresSenderState implements SenderState {
  readonly #pool: Pool;
  readonly #key: Buffer;
  readonly #tenantId: string;
  readonly #client: PoolClient | undefined;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(options: PostgresSenderStateOptions, client?: PoolClient) {
    this.#pool = options.pool;
    this.#key = encryptionKey(options.encryptionKey);
    this.#tenantId = tenantId(options.tenantId);
    this.#client = client;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  async withDeliveryLock<T>(
    deliveryId: string,
    operation: (state: SenderStateOperations) => Promise<T>,
  ): Promise<T> {
    if (senderLockScope.getStore()) {
      throw new Error('Nested sender delivery-lock acquisition is not allowed');
    }

    const client = await this.#pool.connect();
    let operationFailed = false;
    let operationError: unknown;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${this.#tenantId}:${deliveryId}`,
      ]);
      const lockedState = new PostgresSenderState(
        {
          pool: this.#pool,
          encryptionKey: this.#key,
          tenantId: this.#tenantId,
          randomBytes: this.#randomBytes,
        },
        client,
      );
      const value = await senderLockScope.run(true, () => operation(lockedState));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      operationFailed = true;
      operationError = error;
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [operationError, rollbackError],
          'Sender delivery-lock operation and rollback both failed',
        );
      }
      throw error;
    } finally {
      client.release(
        operationFailed && operationError instanceof Error ? operationError : undefined,
      );
    }
  }

  async create(record: SenderDeliveryRecord): Promise<void> {
    const encrypted = this.#encrypt(record);
    try {
      await this.#connection().query(
        `INSERT INTO sender_deliveries (
           tenant_id, delivery_id, record_ciphertext, record_nonce, record_tag
         ) VALUES ($1, $2, $3, $4, $5)`,
        [this.#tenantId, record.deliveryId, encrypted.ciphertext, encrypted.nonce, encrypted.tag],
      );
    } catch (error) {
      if (databaseErrorCode(error) === '23505') {
        throw new Error('Sender delivery ID already exists');
      }
      throw error;
    }
  }

  async get(deliveryId: string): Promise<SenderDeliveryRecord | undefined> {
    const result = await this.#connection().query<SenderDeliveryRow>(
      `SELECT delivery_id, record_ciphertext, record_nonce, record_tag
       FROM sender_deliveries
       WHERE tenant_id = $1 AND delivery_id = $2`,
      [this.#tenantId, deliveryId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.#decrypt(row);
  }

  async save(record: SenderDeliveryRecord): Promise<void> {
    const encrypted = this.#encrypt(record);
    const result = await this.#connection().query(
      `UPDATE sender_deliveries
       SET record_ciphertext = $3,
           record_nonce = $4,
           record_tag = $5,
           updated_at = now()
       WHERE tenant_id = $1 AND delivery_id = $2`,
      [this.#tenantId, record.deliveryId, encrypted.ciphertext, encrypted.nonce, encrypted.tag],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error('Sender delivery does not exist');
    }
  }

  #connection(): DatabaseConnection {
    return this.#client ?? this.#pool;
  }

  #encrypt(record: SenderDeliveryRecord): {
    readonly ciphertext: Buffer;
    readonly nonce: Buffer;
    readonly tag: Buffer;
  } {
    const nonce = this.#randomBytes(12);
    if (nonce.byteLength !== 12) throw new Error('PostgreSQL sender nonce must be 12 bytes');
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(authenticatedData(this.#tenantId, record.deliveryId));
    const ciphertext = Buffer.concat([cipher.update(serializeRecord(record)), cipher.final()]);
    return { ciphertext, nonce, tag: cipher.getAuthTag() };
  }

  #decrypt(row: SenderDeliveryRow): SenderDeliveryRecord {
    const decipher = createDecipheriv('aes-256-gcm', this.#key, row.record_nonce);
    decipher.setAAD(authenticatedData(this.#tenantId, row.delivery_id));
    decipher.setAuthTag(row.record_tag);
    const plaintext = Buffer.concat([decipher.update(row.record_ciphertext), decipher.final()]);
    const record = deserializeRecord(plaintext);
    if (record.deliveryId !== row.delivery_id) {
      throw new Error('PostgreSQL sender record identity is invalid');
    }
    return record;
  }
}

export async function createPostgresSenderState(
  options: CreatePostgresSenderStateOptions,
): Promise<{ readonly pool: Pool; readonly state: PostgresSenderState }> {
  const pool = new Pool({
    connectionString: connectionString(options.connectionString),
    max: positiveInteger(options.maxConnections, 10, 'PostgreSQL sender max connections'),
  });
  try {
    await migratePostgresSenderState(pool);
    return {
      pool,
      state: new PostgresSenderState({
        pool,
        encryptionKey: options.encryptionKey,
        ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      }),
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}
