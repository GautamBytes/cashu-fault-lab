import {
  receiverCrashBoundaries,
  senderCrashBoundaries,
  type CrashBoundary,
} from '@cashu-fault-lab/delivery-core';
import { Pool, type QueryResultRow } from 'pg';

export interface CrashArm {
  readonly runId: string;
  readonly component: 'sender' | 'receiver';
  readonly boundary: CrashBoundary;
  readonly occurrence: number;
  readonly hits: number;
  readonly consumed: boolean;
}

export interface CrashArmStore {
  arm(input: Omit<CrashArm, 'hits' | 'consumed'>): Promise<void>;
  hit(input: Pick<CrashArm, 'runId' | 'component' | 'boundary'>): Promise<boolean>;
  list(runId: string): Promise<readonly CrashArm[]>;
  reset(runId: string): Promise<void>;
}

interface CrashArmRow extends QueryResultRow {
  readonly run_id: string;
  readonly component: 'sender' | 'receiver';
  readonly boundary: CrashBoundary;
  readonly occurrence: number;
  readonly hits: number;
  readonly consumed: boolean;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SENDER_BOUNDARIES = new Set<CrashBoundary>(senderCrashBoundaries);
const RECEIVER_BOUNDARIES = new Set<CrashBoundary>(receiverCrashBoundaries);

function scopedId(value: string, name: string): string {
  if (!ID_PATTERN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function componentBoundary(
  component: CrashArm['component'],
  boundary: CrashBoundary,
): CrashBoundary {
  if (component !== 'sender' && component !== 'receiver') {
    throw new Error('Crash arm component is invalid');
  }
  const allowed = component === 'sender' ? SENDER_BOUNDARIES : RECEIVER_BOUNDARIES;
  if (!allowed.has(boundary)) {
    throw new Error('Crash boundary does not match the selected component');
  }
  return boundary;
}

function occurrence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error('Crash occurrence must be an integer from 1 to 1000000');
  }
  return value;
}

function databaseErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = Reflect.get(value, 'code');
  return typeof code === 'string' ? code : undefined;
}

export async function migratePostgresCrashArmStore(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashu_test_crash_arms (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      component text NOT NULL CHECK (component IN ('sender', 'receiver')),
      boundary text NOT NULL,
      occurrence integer NOT NULL CHECK (occurrence >= 1 AND occurrence <= 1000000),
      hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
      consumed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, run_id, component, boundary)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS cashu_test_crash_arms_run_idx
      ON cashu_test_crash_arms (tenant_id, run_id, created_at)
  `);
}

export interface PostgresCrashArmStoreOptions {
  readonly pool: Pool;
  readonly tenantId?: string;
}

export class PostgresCrashArmStore implements CrashArmStore {
  readonly #pool: Pool;
  readonly #tenantId: string;

  constructor(options: PostgresCrashArmStoreOptions) {
    this.#pool = options.pool;
    this.#tenantId = scopedId(options.tenantId ?? 'cashu-ts', 'Crash arm tenant ID');
  }

  async arm(input: Omit<CrashArm, 'hits' | 'consumed'>): Promise<void> {
    const runId = scopedId(input.runId, 'Crash arm run ID');
    const boundary = componentBoundary(input.component, input.boundary);
    try {
      await this.#pool.query(
        `INSERT INTO cashu_test_crash_arms (
           tenant_id, run_id, component, boundary, occurrence
         ) VALUES ($1, $2, $3, $4, $5)`,
        [this.#tenantId, runId, input.component, boundary, occurrence(input.occurrence)],
      );
    } catch (error) {
      if (databaseErrorCode(error) === '23505') {
        throw new Error('Crash arm already exists');
      }
      throw error;
    }
  }

  async hit(input: Pick<CrashArm, 'runId' | 'component' | 'boundary'>): Promise<boolean> {
    const runId = scopedId(input.runId, 'Crash arm run ID');
    const boundary = componentBoundary(input.component, input.boundary);
    const result = await this.#pool.query<{ readonly consumed_now: boolean }>(
      `UPDATE cashu_test_crash_arms
       SET hits = hits + 1,
           consumed = (hits + 1 = occurrence),
           updated_at = now()
       WHERE tenant_id = $1
         AND run_id = $2
         AND component = $3
         AND boundary = $4
         AND consumed = false
       RETURNING consumed AS consumed_now`,
      [this.#tenantId, runId, input.component, boundary],
    );
    return result.rows[0]?.consumed_now === true;
  }

  async list(runIdValue: string): Promise<readonly CrashArm[]> {
    const runId = scopedId(runIdValue, 'Crash arm run ID');
    const result = await this.#pool.query<CrashArmRow>(
      `SELECT run_id, component, boundary, occurrence, hits, consumed
       FROM cashu_test_crash_arms
       WHERE tenant_id = $1 AND run_id = $2
       ORDER BY created_at, component, boundary`,
      [this.#tenantId, runId],
    );
    return result.rows.map((row) => ({
      runId: row.run_id,
      component: row.component,
      boundary: row.boundary,
      occurrence: row.occurrence,
      hits: row.hits,
      consumed: row.consumed,
    }));
  }

  async reset(runIdValue: string): Promise<void> {
    const runId = scopedId(runIdValue, 'Crash arm run ID');
    await this.#pool.query(
      `DELETE FROM cashu_test_crash_arms WHERE tenant_id = $1 AND run_id = $2`,
      [this.#tenantId, runId],
    );
  }
}
