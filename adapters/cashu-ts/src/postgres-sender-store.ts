import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as secureRandomBytes,
} from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { AdapterDurability } from '@cashu-fault-lab/adapter-contract';
import type { CashuTsDeliveryStore, CashuTsStoredDelivery } from './funded-operations.js';

interface SenderDeliveryRow extends QueryResultRow {
  readonly delivery_id: string;
  readonly record_ciphertext: Buffer;
  readonly record_nonce: Buffer;
  readonly record_tag: Buffer;
  readonly key_version: number;
}

interface SerializedCashuTsStoredDelivery extends Omit<CashuTsStoredDelivery, 'payloadBytes'> {
  readonly payloadBytes: string;
}

export interface CashuTsSenderStateKeyRing {
  readonly activeKeyVersion: number;
  readonly keys: ReadonlyMap<number, Buffer>;
}

export interface ParseCashuTsSenderStateKeysInput {
  readonly activeKeyVersion: number;
  readonly encodedKeys: string;
}

export interface PostgresCashuTsSenderStoreOptions {
  readonly pool: Pool;
  readonly keyRing: CashuTsSenderStateKeyRing;
  readonly runId: string;
  readonly tenantId?: string;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface CreatePostgresCashuTsSenderStoreOptions {
  readonly connectionString: string;
  readonly keyRing: CashuTsSenderStateKeyRing;
  readonly runId: string;
  readonly tenantId?: string;
  readonly maxConnections?: number;
}

type DatabaseConnection = Pool | PoolClient;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/u;

function scopedId(value: string | undefined, fallback: string, name: string): string {
  const selected = value ?? fallback;
  if (!ID_PATTERN.test(selected)) throw new Error(`${name} is invalid`);
  return selected;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 100) {
    throw new Error(`${name} must be an integer from 1 to 100`);
  }
  return selected;
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

function keyVersion(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function databaseErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = Reflect.get(value, 'code');
  return typeof code === 'string' ? code : undefined;
}

function senderSeedFingerprint(seed: string): string {
  return createHash('sha256')
    .update('cashu-fault-lab/cashu-ts-sender-seed-fingerprint-v1\0')
    .update(seed)
    .digest('hex');
}

function walletSeedPlaintext(seed: string): string {
  return createHash('sha512')
    .update('cashu-fault-lab/cashu-ts-wallet-seed-v1\0')
    .update(seed)
    .digest('base64url');
}

function authenticatedData(input: {
  readonly domain: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly identity: string;
  readonly keyVersion: number;
}): Buffer {
  return Buffer.from(
    JSON.stringify([
      `cashu-fault-lab/${input.domain}/v2`,
      input.tenantId,
      input.runId,
      input.identity,
      input.keyVersion,
    ]),
    'utf8',
  );
}

function serializeRecord(record: CashuTsStoredDelivery): Buffer {
  const serialized: SerializedCashuTsStoredDelivery = {
    ...record,
    payloadBytes: Buffer.from(record.payloadBytes).toString('base64url'),
  };
  return Buffer.from(JSON.stringify(serialized), 'utf8');
}

function deserializeRecord(value: Buffer): CashuTsStoredDelivery {
  const parsed = JSON.parse(value.toString('utf8')) as Partial<SerializedCashuTsStoredDelivery>;
  if (typeof parsed.deliveryId !== 'string' || parsed.deliveryId.length === 0) {
    throw new Error('Cashu sender delivery identity is invalid');
  }
  if (typeof parsed.payloadBytes !== 'string') {
    throw new Error('Cashu sender payload bytes are invalid');
  }
  return {
    ...(parsed as Omit<SerializedCashuTsStoredDelivery, 'payloadBytes'>),
    payloadBytes: Uint8Array.from(Buffer.from(parsed.payloadBytes, 'base64url')),
  };
}

function selectedTransportIndex(record: CashuTsStoredDelivery): number {
  return Math.max(0, Math.min(record.attempts - 1, record.transports.length - 1));
}

function lifecyclePhase(record: CashuTsStoredDelivery): string {
  if (record.receipt?.status === 'settled') return 'SETTLED';
  if (record.receipt?.status === 'rejected') return 'REJECTED';
  if (record.attempts > 0) return 'SENDING';
  return 'PAYLOAD_PERSISTED';
}

export function parseCashuTsSenderStateKeys(
  input: ParseCashuTsSenderStateKeysInput,
): CashuTsSenderStateKeyRing {
  const activeKeyVersion = keyVersion(input.activeKeyVersion, 'Active key version');
  const keys = new Map<number, Buffer>();
  const entries = input.encodedKeys
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new Error('Cashu sender state keys are malformed');
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator !== entry.lastIndexOf(':')) {
      throw new Error('Cashu sender state key entry is malformed');
    }
    const versionText = entry.slice(0, separator);
    const keyText = entry.slice(separator + 1);
    if (!/^[1-9]\d*$/u.test(versionText) || !BASE64URL_KEY_PATTERN.test(keyText)) {
      throw new Error('Cashu sender state key entry is malformed');
    }
    const version = keyVersion(Number(versionText), 'State key version');
    if (keys.has(version)) throw new Error('Cashu sender state key version is duplicate');
    const decoded = Buffer.from(keyText, 'base64url');
    if (decoded.byteLength !== 32) {
      throw new Error('Cashu sender state keys must decode to exactly 32 bytes');
    }
    keys.set(version, decoded);
  }
  if (!keys.has(activeKeyVersion)) {
    throw new Error('Cashu sender active key version must be present in readable keys');
  }
  return { activeKeyVersion, keys };
}

export async function migratePostgresCashuTsSenderStore(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashu_sender_runs (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      seed_fingerprint text NOT NULL,
      wallet_seed_ciphertext bytea NOT NULL,
      wallet_seed_nonce bytea NOT NULL,
      wallet_seed_tag bytea NOT NULL,
      state_key_version integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, run_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashu_sender_deliveries (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      delivery_id text NOT NULL,
      request_fingerprint text NOT NULL,
      payload_hash text NOT NULL,
      selected_transport_index integer NOT NULL,
      attempts integer NOT NULL,
      lifecycle_phase text NOT NULL,
      record_ciphertext bytea NOT NULL,
      record_nonce bytea NOT NULL,
      record_tag bytea NOT NULL,
      key_version integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, run_id, delivery_id),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES cashu_sender_runs (tenant_id, run_id)
        ON DELETE CASCADE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashu_sender_proofs (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      proof_y text NOT NULL,
      ciphertext bytea NOT NULL,
      nonce bytea NOT NULL,
      tag bytea NOT NULL,
      key_version integer NOT NULL,
      state text NOT NULL,
      delivery_id text NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, run_id, proof_y),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES cashu_sender_runs (tenant_id, run_id)
        ON DELETE CASCADE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashu_sender_reservations (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      delivery_id text NOT NULL,
      request_fingerprint text NOT NULL,
      phase text NOT NULL,
      ciphertext bytea NOT NULL,
      nonce bytea NOT NULL,
      tag bytea NOT NULL,
      key_version integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, run_id, delivery_id),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES cashu_sender_runs (tenant_id, run_id)
        ON DELETE CASCADE
    )
  `);
}

export class PostgresCashuTsSenderStore implements CashuTsDeliveryStore {
  readonly durability: AdapterDurability = 'persistent';
  readonly #pool: Pool;
  readonly #keyRing: CashuTsSenderStateKeyRing;
  readonly #tenantId: string;
  readonly #runId: string;
  readonly #randomBytes: (size: number) => Uint8Array;

  constructor(options: PostgresCashuTsSenderStoreOptions) {
    this.#pool = options.pool;
    this.#keyRing = options.keyRing;
    this.#tenantId = scopedId(options.tenantId, 'cashu-ts', 'Cashu sender tenant ID');
    this.#runId = scopedId(options.runId, 'default', 'Cashu sender run ID');
    if (!this.#keyRing.keys.has(this.#keyRing.activeKeyVersion)) {
      throw new Error('Cashu sender active key version must be readable');
    }
    this.#randomBytes = options.randomBytes ?? secureRandomBytes;
  }

  async reset(seed: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await this.#withRunLock(client);
      await client.query(
        `DELETE FROM cashu_sender_deliveries WHERE tenant_id = $1 AND run_id = $2`,
        [this.#tenantId, this.#runId],
      );
      await client.query(`DELETE FROM cashu_sender_proofs WHERE tenant_id = $1 AND run_id = $2`, [
        this.#tenantId,
        this.#runId,
      ]);
      await client.query(
        `DELETE FROM cashu_sender_reservations WHERE tenant_id = $1 AND run_id = $2`,
        [this.#tenantId, this.#runId],
      );
      await client.query(`DELETE FROM cashu_sender_runs WHERE tenant_id = $1 AND run_id = $2`, [
        this.#tenantId,
        this.#runId,
      ]);
      const encrypted = this.#encrypt('cashu-sender-run', 'wallet-seed', walletSeedPlaintext(seed));
      await client.query(
        `INSERT INTO cashu_sender_runs (
           tenant_id, run_id, seed_fingerprint, wallet_seed_ciphertext, wallet_seed_nonce,
           wallet_seed_tag, state_key_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          this.#tenantId,
          this.#runId,
          senderSeedFingerprint(seed),
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          encrypted.keyVersion,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Cashu sender reset and rollback both failed',
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async get(deliveryId: string): Promise<CashuTsStoredDelivery | undefined> {
    const result = await this.#pool.query<SenderDeliveryRow>(
      `SELECT delivery_id, record_ciphertext, record_nonce, record_tag, key_version
       FROM cashu_sender_deliveries
       WHERE tenant_id = $1 AND run_id = $2 AND delivery_id = $3`,
      [this.#tenantId, this.#runId, deliveryId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.#decryptRecord(row);
  }

  async put(record: CashuTsStoredDelivery): Promise<void> {
    const encrypted = this.#encrypt(
      'cashu-sender-delivery',
      record.deliveryId,
      serializeRecord(record),
    );
    try {
      await this.#pool.query(
        `INSERT INTO cashu_sender_deliveries (
           tenant_id, run_id, delivery_id, request_fingerprint, payload_hash,
           selected_transport_index, attempts, lifecycle_phase, record_ciphertext, record_nonce,
           record_tag, key_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, run_id, delivery_id) DO UPDATE
         SET request_fingerprint = EXCLUDED.request_fingerprint,
             payload_hash = EXCLUDED.payload_hash,
             selected_transport_index = EXCLUDED.selected_transport_index,
             attempts = EXCLUDED.attempts,
             lifecycle_phase = EXCLUDED.lifecycle_phase,
             record_ciphertext = EXCLUDED.record_ciphertext,
             record_nonce = EXCLUDED.record_nonce,
             record_tag = EXCLUDED.record_tag,
             key_version = EXCLUDED.key_version,
             updated_at = now()`,
        [
          this.#tenantId,
          this.#runId,
          record.deliveryId,
          record.requestFingerprint,
          record.payloadHash,
          selectedTransportIndex(record),
          record.attempts,
          lifecyclePhase(record),
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          encrypted.keyVersion,
        ],
      );
    } catch (error) {
      if (databaseErrorCode(error) === '23503') {
        throw new Error('Cashu sender run is not initialized');
      }
      throw error;
    }
  }

  async list(): Promise<readonly CashuTsStoredDelivery[]> {
    const result = await this.#pool.query<SenderDeliveryRow>(
      `SELECT delivery_id, record_ciphertext, record_nonce, record_tag, key_version
       FROM cashu_sender_deliveries
       WHERE tenant_id = $1 AND run_id = $2
       ORDER BY created_at, delivery_id`,
      [this.#tenantId, this.#runId],
    );
    return result.rows.map((row) => this.#decryptRecord(row));
  }

  async #withRunLock(client: DatabaseConnection): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${this.#tenantId}:${this.#runId}:wallet`,
    ]);
  }

  #encrypt(
    domain: string,
    identity: string,
    value: unknown,
  ): {
    readonly ciphertext: Buffer;
    readonly nonce: Buffer;
    readonly tag: Buffer;
    readonly keyVersion: number;
  } {
    const keyVersion = this.#keyRing.activeKeyVersion;
    const key = this.#keyRing.keys.get(keyVersion);
    if (key === undefined) throw new Error('Cashu sender active key version is unreadable');
    const nonce = Buffer.from(this.#randomBytes(12));
    if (nonce.byteLength !== 12) throw new Error('Cashu sender nonce must contain 12 bytes');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(
      authenticatedData({
        domain,
        tenantId: this.#tenantId,
        runId: this.#runId,
        identity,
        keyVersion,
      }),
    );
    const plaintext = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, nonce, tag: cipher.getAuthTag(), keyVersion };
  }

  #decryptRecord(row: SenderDeliveryRow): CashuTsStoredDelivery {
    const plaintext = this.#decrypt(
      'cashu-sender-delivery',
      row.delivery_id,
      row.key_version,
      row.record_ciphertext,
      row.record_nonce,
      row.record_tag,
    );
    const record = deserializeRecord(plaintext);
    if (record.deliveryId !== row.delivery_id) {
      throw new Error('Cashu sender delivery identity is invalid');
    }
    return record;
  }

  #decrypt(
    domain: string,
    identity: string,
    keyVersion: number,
    ciphertext: Buffer,
    nonce: Buffer,
    tag: Buffer,
  ): Buffer {
    const key = this.#keyRing.keys.get(keyVersion);
    if (key === undefined) throw new Error('Cashu sender state key version is unknown');
    try {
      if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
        throw new Error('invalid envelope dimensions');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(
        authenticatedData({
          domain,
          tenantId: this.#tenantId,
          runId: this.#runId,
          identity,
          keyVersion,
        }),
      );
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Unable to decrypt or authenticate Cashu sender state');
    }
  }
}

export async function createPostgresCashuTsSenderStore(
  options: CreatePostgresCashuTsSenderStoreOptions,
): Promise<{ readonly pool: Pool; readonly store: PostgresCashuTsSenderStore }> {
  const pool = new Pool({
    connectionString: connectionString(options.connectionString),
    max: positiveInteger(options.maxConnections, 10, 'PostgreSQL sender max connections'),
  });
  try {
    await migratePostgresCashuTsSenderStore(pool);
    return {
      pool,
      store: new PostgresCashuTsSenderStore({
        pool,
        keyRing: options.keyRing,
        runId: options.runId,
        ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      }),
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}
