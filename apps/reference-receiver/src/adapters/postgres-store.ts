import {
  assertReceiptTransition,
  normalizeMintUrl,
  parseProtocolId,
  type DeliveryReceipt,
} from '@cashu-fault-lab/delivery-core';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  ReceiverDomainError,
  type CommitSettlement,
  type CreatePaymentRequest,
  type DeliveryPhase,
  type DeliveryRecord,
  type ExactSwapPlan,
  type MerchantCredit,
  type PaymentRequestRecord,
  type PrepareDelivery,
  type PrepareResult,
} from '../domain/types.js';
import type { ExactSwapPlanView, ReceiverStore } from '../ports/receiver-store.js';
import {
  CryptoEnvelope,
  replacementAuthenticatedData,
  swapPlanAuthenticatedData,
} from './crypto-envelope.js';
import { isSameDeliveryBinding, validateRequestBinding } from '../domain/request-binding.js';
import { assertSafeInteger, nextReceipt, sameRequest, sameDelivery } from './store-helpers.js';

interface DeliveryRow extends QueryResultRow {
  readonly delivery_id: string;
  readonly request_id: string;
  readonly payload_hash: string;
  readonly proof_set_hash: string;
  readonly mint: string;
  readonly unit: string;
  readonly amount: string;
  readonly phase: DeliveryPhase;
  readonly receipt: DeliveryReceipt | string;
  readonly swap_plan_ciphertext: Buffer;
  readonly swap_plan_nonce: Buffer;
  readonly swap_plan_tag: Buffer;
  readonly replacement_plan_hash: string | null;
  readonly replacement_ciphertext: Buffer | null;
  readonly replacement_nonce: Buffer | null;
  readonly replacement_tag: Buffer | null;
}

interface RequestRow extends QueryResultRow {
  readonly request_id: string;
  readonly amount: string;
  readonly unit: string;
  readonly mints: readonly string[] | string;
  readonly single_use: boolean;
  readonly expires_at: string;
}

interface CreditRow extends QueryResultRow {
  readonly credit_id: string;
  readonly request_id: string;
  readonly delivery_id: string;
  readonly amount: string;
  readonly unit: string;
  readonly created_at: string;
}

type DatabaseConnection = Pool | PoolClient;

const RECOVERY_WORK_LEASE_SECONDS = 30;

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function safeDatabaseInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ReceiverDomainError('INVALID_STATE', `${name} is outside safe integer range`);
  }
  return parsed;
}

function databaseErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = Reflect.get(value, 'code');
  return typeof code === 'string' ? code : undefined;
}

export class PostgresReceiverStore implements ReceiverStore {
  readonly #pool: Pool;
  readonly #envelope: CryptoEnvelope;
  readonly #tenantId: string;
  readonly #client: PoolClient | undefined;

  constructor(pool: Pool, envelope: CryptoEnvelope, tenantId = 'default', client?: PoolClient) {
    if (tenantId.length === 0) throw new Error('Tenant ID is required');
    this.#pool = pool;
    this.#envelope = envelope;
    this.#tenantId = tenantId;
    this.#client = client;
  }

  async createRequest(input: CreatePaymentRequest): Promise<PaymentRequestRecord> {
    const id = parseProtocolId(input.id);
    assertSafeInteger(input.amount, 'Request amount');
    assertSafeInteger(input.expiresAt, 'Request expiry');
    if (input.unit.length === 0 || input.mints.length === 0) {
      throw new ReceiverDomainError('INVALID_REQUEST', 'Request unit and mint set are required');
    }
    const mints = [...new Set(input.mints.map(normalizeMintUrl))].sort();
    const record: PaymentRequestRecord = {
      id,
      amount: input.amount,
      unit: input.unit,
      mints,
      singleUse: input.singleUse,
      expiresAt: input.expiresAt,
    };
    return this.#serializable(async (client) => {
      await client.query(
        `INSERT INTO payment_requests (request_id, amount, unit, mints, single_use, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          id,
          record.amount,
          record.unit,
          JSON.stringify(record.mints),
          record.singleUse,
          record.expiresAt,
        ],
      );
      const stored = await this.#request(client, id);
      if (!stored || !sameRequest(stored, record)) {
        throw new ReceiverDomainError('INVALID_REQUEST', 'Request ID is already bound');
      }
      return stored;
    });
  }

  async preflight(
    command: PrepareDelivery['command'],
    now: number,
  ): Promise<DeliveryRecord | undefined> {
    return this.#serializable(async (client) => {
      const previous = await this.#delivery(client, command.payload.delivery.id, false);
      if (previous) {
        if (!isSameDeliveryBinding(previous, command)) {
          throw new ReceiverDomainError('DELIVERY_CONFLICT', 'Delivery ID is already bound');
        }
        return previous;
      }
      const request = await this.#request(client, command.payload.id);
      if (!request) throw new ReceiverDomainError('REQUEST_NOT_FOUND', 'Payment request not found');
      validateRequestBinding(request, command, now);
      if (request.singleUse) {
        const reservation = await client.query(
          `SELECT 1 FROM deliveries
           WHERE request_id = $1 AND single_use AND phase <> 'rejected'
           LIMIT 1`,
          [request.id],
        );
        if (reservation.rowCount) {
          throw new ReceiverDomainError(
            'SINGLE_USE_CONFLICT',
            'Single-use request is already claimed',
          );
        }
      }
      return undefined;
    });
  }

  async withRedemptionLock<T>(
    deliveryId: string,
    operation: (lockedStore: ReceiverStore) => Promise<T>,
  ): Promise<{ readonly acquired: false } | { readonly acquired: true; readonly value: T }> {
    const client = await this.#pool.connect();
    let acquired: boolean;
    try {
      const selected = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [deliveryId],
      );
      acquired = selected.rows[0]?.acquired === true;
    } catch (error) {
      client.release(error instanceof Error ? error : undefined);
      throw error;
    }
    if (!acquired) {
      client.release();
      return { acquired: false };
    }

    let value!: T;
    let operationFailed = false;
    let operationError: unknown;
    try {
      value = await operation(
        new PostgresReceiverStore(this.#pool, this.#envelope, this.#tenantId, client),
      );
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    let unlockFailed = false;
    let unlockError: unknown;
    try {
      const unlocked = await client.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
        [deliveryId],
      );
      if (unlocked.rows[0]?.unlocked !== true) {
        throw new Error('PostgreSQL redemption lock was not held during release');
      }
    } catch (error) {
      unlockFailed = true;
      unlockError = error;
    }
    client.release(unlockFailed && unlockError instanceof Error ? unlockError : undefined);

    if (operationFailed && unlockFailed) {
      throw new AggregateError(
        [operationError, unlockError],
        'Redemption operation and lock release both failed',
      );
    }
    if (operationFailed) throw operationError;
    if (unlockFailed) throw unlockError;
    return { acquired: true, value };
  }

  async prepare(input: PrepareDelivery): Promise<PrepareResult> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await this.#serializable(async (client) => {
          const request = await this.#request(client, input.command.payload.id);
          if (!request) {
            throw new ReceiverDomainError('REQUEST_NOT_FOUND', 'Payment request not found');
          }
          this.#validatePrepare(request, input);
          const previous = await this.#delivery(client, input.command.payload.delivery.id, false);
          if (previous) {
            if (!sameDelivery(previous, input)) {
              throw new ReceiverDomainError('DELIVERY_CONFLICT', 'Delivery ID is already bound');
            }
            return { kind: 'duplicate', record: previous };
          }

          const receipt: DeliveryReceipt = {
            profile: 'cashu-delivery-v1',
            requestId: request.id,
            deliveryId: input.command.payload.delivery.id,
            payloadHash: input.command.payloadHash,
            status: 'processing',
            statusVersion: 1,
            mint: input.command.payload.mint,
            unit: input.command.payload.unit,
            amount: request.amount,
            detailCode: 'accepted',
          };
          assertReceiptTransition(undefined, receipt);
          const encrypted = this.#envelope.encrypt(
            input.plan,
            swapPlanAuthenticatedData({
              requestId: request.id,
              deliveryId: input.command.payload.delivery.id,
              payloadHash: input.command.payloadHash,
            }),
          );
          await client.query(
            `INSERT INTO deliveries (
             delivery_id, request_id, payload_hash, proof_set_hash, mint, unit, amount,
             single_use, phase, receipt, swap_plan_ciphertext, swap_plan_nonce, swap_plan_tag
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'prepared', $9::jsonb, $10, $11, $12)`,
            [
              input.command.payload.delivery.id,
              request.id,
              input.command.payloadHash,
              input.proofSetHash,
              input.command.payload.mint,
              input.command.payload.unit,
              request.amount,
              request.singleUse,
              JSON.stringify(receipt),
              Buffer.from(encrypted.ciphertext),
              Buffer.from(encrypted.nonce),
              Buffer.from(encrypted.tag),
            ],
          );
          for (const proofClaimId of input.proofClaimIds) {
            await client.query(
              `INSERT INTO proof_claims (tenant_id, mint, unit, proof_y_hmac, delivery_id)
             VALUES ($1, $2, $3, $4, $5)`,
              [
                this.#tenantId,
                input.command.payload.mint,
                input.command.payload.unit,
                proofClaimId,
                input.command.payload.delivery.id,
              ],
            );
          }
          const record = await this.#delivery(client, input.command.payload.delivery.id, false);
          if (!record)
            throw new ReceiverDomainError('INVALID_STATE', 'Prepared delivery disappeared');
          return { kind: 'prepared', record };
        });
      } catch (error) {
        if (databaseErrorCode(error) !== '23505') throw error;
        const conflict = await this.#classifyPrepareConflict(input);
        if (conflict) return conflict;
        if (attempt === 5) {
          throw new ReceiverDomainError(
            'INVALID_STATE',
            'Database uniqueness conflict remained unclassifiable after retries',
          );
        }
      }
    }
    throw new ReceiverDomainError('INVALID_STATE', 'Prepare retry exhausted');
  }

  async markMintSent(deliveryId: string): Promise<DeliveryReceipt> {
    return this.#serializable(async (client) => {
      const record = await this.#requiredDelivery(client, deliveryId, true);
      if (record.phase !== 'prepared') return record.receipt;
      const receipt = nextReceipt(record.receipt, 'processing', 'redeeming');
      await this.#updatePhase(client, deliveryId, 'mint_sent', receipt);
      return receipt;
    });
  }

  async settle(input: CommitSettlement): Promise<DeliveryReceipt> {
    return this.#serializable(async (client) => {
      const record = await this.#requiredDelivery(client, input.deliveryId, true);
      if (record.phase === 'settled') {
        if (record.replacementPlanHash !== input.replacementPlanHash) {
          throw new ReceiverDomainError('INVALID_STATE', 'Settlement result is conflicting');
        }
        return record.receipt;
      }
      if (record.phase === 'rejected' || record.phase === 'prepared') {
        throw new ReceiverDomainError('INVALID_STATE', 'Delivery cannot settle from current phase');
      }
      if (input.replacementPlanHash.length === 0 || input.replacementProofs.length === 0) {
        throw new ReceiverDomainError('INVALID_STATE', 'Recovered outputs are required to settle');
      }
      assertSafeInteger(input.now, 'Settlement time');
      const receipt = nextReceipt(record.receipt, 'settled', 'settled');
      const encrypted = this.#envelope.encrypt(
        input.replacementProofs,
        replacementAuthenticatedData({
          requestId: record.requestId,
          deliveryId: record.deliveryId,
          payloadHash: record.payloadHash,
          replacementPlanHash: input.replacementPlanHash,
        }),
      );
      await client.query(
        `INSERT INTO merchant_credits (delivery_id, credit_id, request_id, amount, unit, created_at)
         VALUES ($1, $1, $2, $3, $4, $5)
         ON CONFLICT (delivery_id) DO NOTHING`,
        [record.deliveryId, record.requestId, record.amount, record.receipt.unit, input.now],
      );
      const credit = await this.#credit(client, record.deliveryId);
      if (
        !credit ||
        credit.requestId !== record.requestId ||
        credit.amount !== record.amount ||
        credit.unit !== record.receipt.unit
      ) {
        throw new ReceiverDomainError('INVALID_STATE', 'Merchant credit is conflicting');
      }
      await client.query(
        `UPDATE deliveries
         SET phase = 'settled', receipt = $2::jsonb, replacement_plan_hash = $3,
             replacement_ciphertext = $4, replacement_nonce = $5, replacement_tag = $6,
             updated_at = now()
         WHERE delivery_id = $1`,
        [
          record.deliveryId,
          JSON.stringify(receipt),
          input.replacementPlanHash,
          Buffer.from(encrypted.ciphertext),
          Buffer.from(encrypted.nonce),
          Buffer.from(encrypted.tag),
        ],
      );
      await client.query(
        `INSERT INTO receipt_outbox (delivery_id, status_version, body)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (delivery_id, status_version) DO NOTHING`,
        [record.deliveryId, receipt.statusVersion, JSON.stringify(receipt)],
      );
      return receipt;
    });
  }

  async blockRecovery(deliveryId: string): Promise<DeliveryReceipt> {
    return this.#serializable(async (client) => {
      const record = await this.#requiredDelivery(client, deliveryId, true);
      if (record.phase === 'settled' || record.phase === 'recovery_blocked') return record.receipt;
      if (record.phase === 'rejected') {
        throw new ReceiverDomainError('INVALID_STATE', 'Rejected delivery cannot block recovery');
      }
      const receipt = nextReceipt(record.receipt, 'processing', 'recovery_blocked');
      await this.#updatePhase(client, deliveryId, 'recovery_blocked', receipt);
      return receipt;
    });
  }

  async reject(
    deliveryId: string,
    detailCode: string,
    releaseClaims: boolean,
  ): Promise<DeliveryReceipt> {
    return this.#serializable(async (client) => {
      const record = await this.#requiredDelivery(client, deliveryId, true);
      if (record.phase === 'rejected') return record.receipt;
      if (record.phase === 'settled' || record.phase === 'recovery_blocked') {
        throw new ReceiverDomainError('INVALID_STATE', 'Possibly consumed delivery cannot reject');
      }
      const receipt = nextReceipt(record.receipt, 'rejected', detailCode);
      await this.#updatePhase(client, deliveryId, 'rejected', receipt);
      if (releaseClaims) {
        await client.query('DELETE FROM proof_claims WHERE delivery_id = $1', [deliveryId]);
      }
      return receipt;
    });
  }

  async current(deliveryId: string): Promise<DeliveryRecord | undefined> {
    return this.#delivery(this.#connection(), deliveryId, false);
  }

  async settlementPlans(): Promise<readonly ExactSwapPlanView[]> {
    const result = await this.#connection().query<{
      delivery_id: string;
      mint: string;
      unit: string;
      amount: string;
    }>('SELECT delivery_id, mint, unit, amount FROM deliveries ORDER BY delivery_id');
    return result.rows.map((row) => ({
      deliveryId: row.delivery_id,
      mint: row.mint,
      unit: row.unit,
      expectedAmount: safeDatabaseInteger(row.amount, 'Delivery amount'),
    }));
  }

  async credits(): Promise<readonly MerchantCredit[]> {
    const result = await this.#connection().query<CreditRow>(
      'SELECT credit_id, request_id, delivery_id, amount, unit, created_at FROM merchant_credits ORDER BY delivery_id',
    );
    return result.rows.map((row) => this.#creditFromRow(row));
  }

  async recoverableDeliveryIds(limit = 100): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('Recovery limit is invalid');
    }
    const result = await this.#connection().query<{ delivery_id: string }>(
      `WITH candidates AS (
         SELECT delivery_id
         FROM deliveries
         WHERE phase IN ('prepared', 'mint_sent', 'recovery_blocked')
           AND updated_at <= now() - ($2 * interval '1 second')
         ORDER BY updated_at, delivery_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE deliveries AS delivery
       SET updated_at = now()
       FROM candidates
       WHERE delivery.delivery_id = candidates.delivery_id
       RETURNING delivery.delivery_id`,
      [limit, RECOVERY_WORK_LEASE_SECONDS],
    );
    return result.rows.map((row) => row.delivery_id);
  }

  async publishOutboxBatch(
    publish: (receipt: DeliveryReceipt) => Promise<void>,
    limit = 100,
  ): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Outbox limit is invalid');
    }
    return this.#serializable(async (client) => {
      const rows = await client.query<{ id: string; body: DeliveryReceipt | string }>(
        `SELECT id, body FROM receipt_outbox
         WHERE published_at IS NULL
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      for (const row of rows.rows) {
        await publish(parseJson(row.body));
        await client.query('UPDATE receipt_outbox SET published_at = now() WHERE id = $1', [
          row.id,
        ]);
      }
      return rows.rowCount ?? 0;
    });
  }

  #validatePrepare(request: PaymentRequestRecord, input: PrepareDelivery): void {
    const payload = input.command.payload;
    validateRequestBinding(request, input.command, input.now);
    if (input.netAmount !== request.amount) {
      throw new ReceiverDomainError('AMOUNT_MISMATCH', 'Delivery amount does not match request');
    }
    if (
      input.proofClaimIds.length !== payload.proofs.length ||
      input.proofYs.length !== payload.proofs.length ||
      new Set(input.proofClaimIds).size !== input.proofClaimIds.length ||
      !/^[0-9a-f]{64}$/.test(input.proofSetHash) ||
      input.proofClaimIds.some((claim) => !/^[0-9a-f]{64}$/.test(claim))
    ) {
      throw new ReceiverDomainError('INVALID_PROOF_EVIDENCE', 'Proof evidence is incomplete');
    }
  }

  async #classifyPrepareConflict(input: PrepareDelivery): Promise<PrepareResult | undefined> {
    const previous = await this.current(input.command.payload.delivery.id);
    if (previous) {
      if (sameDelivery(previous, input)) return { kind: 'duplicate', record: previous };
      throw new ReceiverDomainError('DELIVERY_CONFLICT', 'Delivery ID is already bound');
    }
    const proof = await this.#connection().query<{ delivery_id: string }>(
      `SELECT delivery_id FROM proof_claims
       WHERE tenant_id = $1 AND mint = $2 AND unit = $3 AND proof_y_hmac = ANY($4::text[])
       LIMIT 1`,
      [this.#tenantId, input.command.payload.mint, input.command.payload.unit, input.proofClaimIds],
    );
    if (proof.rowCount) {
      throw new ReceiverDomainError('PROOF_CONFLICT', 'Proof is already claimed');
    }
    const request = await this.#connection().query<{ delivery_id: string }>(
      `SELECT delivery_id FROM deliveries
       WHERE request_id = $1 AND single_use AND phase <> 'rejected' LIMIT 1`,
      [input.command.payload.id],
    );
    if (request.rowCount) {
      throw new ReceiverDomainError('SINGLE_USE_CONFLICT', 'Single-use request is already claimed');
    }
    return undefined;
  }

  async #request(
    connection: DatabaseConnection,
    requestId: string,
  ): Promise<PaymentRequestRecord | undefined> {
    const result = await connection.query<RequestRow>(
      `SELECT request_id, amount, unit, mints, single_use, expires_at
       FROM payment_requests WHERE request_id = $1`,
      [requestId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: parseProtocolId(row.request_id),
      amount: safeDatabaseInteger(row.amount, 'Request amount'),
      unit: row.unit,
      mints: parseJson(row.mints),
      singleUse: row.single_use,
      expiresAt: safeDatabaseInteger(row.expires_at, 'Request expiry'),
    };
  }

  async #delivery(
    connection: DatabaseConnection,
    deliveryId: string,
    forUpdate: boolean,
  ): Promise<DeliveryRecord | undefined> {
    const result = await connection.query<DeliveryRow>(
      `SELECT delivery_id, request_id, payload_hash, proof_set_hash, mint, unit, amount, phase,
              receipt, swap_plan_ciphertext, swap_plan_nonce, swap_plan_tag,
              replacement_plan_hash, replacement_ciphertext, replacement_nonce, replacement_tag
       FROM deliveries WHERE delivery_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [deliveryId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const claims = await connection.query<{ proof_y_hmac: string }>(
      'SELECT proof_y_hmac FROM proof_claims WHERE delivery_id = $1 ORDER BY proof_y_hmac',
      [deliveryId],
    );
    const plan = this.#envelope.decrypt<ExactSwapPlan>(
      {
        ciphertext: row.swap_plan_ciphertext,
        nonce: row.swap_plan_nonce,
        tag: row.swap_plan_tag,
      },
      swapPlanAuthenticatedData({
        requestId: row.request_id,
        deliveryId: row.delivery_id,
        payloadHash: row.payload_hash,
      }),
    );
    let replacementProofs: readonly string[] | undefined;
    if (
      row.replacement_plan_hash &&
      row.replacement_ciphertext &&
      row.replacement_nonce &&
      row.replacement_tag
    ) {
      replacementProofs = this.#envelope.decrypt<readonly string[]>(
        {
          ciphertext: row.replacement_ciphertext,
          nonce: row.replacement_nonce,
          tag: row.replacement_tag,
        },
        replacementAuthenticatedData({
          requestId: row.request_id,
          deliveryId: row.delivery_id,
          payloadHash: row.payload_hash,
          replacementPlanHash: row.replacement_plan_hash,
        }),
      );
    }
    return {
      requestId: parseProtocolId(row.request_id),
      deliveryId: parseProtocolId(row.delivery_id),
      payloadHash: row.payload_hash,
      proofSetHash: row.proof_set_hash,
      proofClaimIds: claims.rows.map((claim) => claim.proof_y_hmac),
      plan,
      amount: safeDatabaseInteger(row.amount, 'Delivery amount'),
      phase: row.phase,
      receipt: parseJson(row.receipt),
      ...(row.replacement_plan_hash ? { replacementPlanHash: row.replacement_plan_hash } : {}),
      ...(replacementProofs ? { replacementProofs } : {}),
    };
  }

  async #requiredDelivery(
    connection: DatabaseConnection,
    deliveryId: string,
    forUpdate: boolean,
  ): Promise<DeliveryRecord> {
    const record = await this.#delivery(connection, deliveryId, forUpdate);
    if (!record) throw new ReceiverDomainError('INVALID_STATE', 'Delivery does not exist');
    return record;
  }

  async #credit(
    connection: DatabaseConnection,
    deliveryId: string,
  ): Promise<MerchantCredit | undefined> {
    const result = await connection.query<CreditRow>(
      `SELECT credit_id, request_id, delivery_id, amount, unit, created_at
       FROM merchant_credits WHERE delivery_id = $1`,
      [deliveryId],
    );
    return result.rows[0] ? this.#creditFromRow(result.rows[0]) : undefined;
  }

  #creditFromRow(row: CreditRow): MerchantCredit {
    return {
      creditId: row.credit_id,
      requestId: parseProtocolId(row.request_id),
      deliveryId: parseProtocolId(row.delivery_id),
      amount: safeDatabaseInteger(row.amount, 'Credit amount'),
      unit: row.unit,
      createdAt: safeDatabaseInteger(row.created_at, 'Credit time'),
    };
  }

  async #updatePhase(
    client: PoolClient,
    deliveryId: string,
    phase: DeliveryPhase,
    receipt: DeliveryReceipt,
  ): Promise<void> {
    await client.query(
      `UPDATE deliveries SET phase = $2, receipt = $3::jsonb, updated_at = now()
       WHERE delivery_id = $1`,
      [deliveryId, phase, JSON.stringify(receipt)],
    );
  }

  async #serializable<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const client = this.#client ?? (await this.#pool.connect());
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = databaseErrorCode(error);
        if ((code === '40001' || code === '40P01') && attempt < 5) continue;
        throw error;
      } finally {
        if (!this.#client) client.release();
      }
    }
    throw new ReceiverDomainError('INVALID_STATE', 'Serializable transaction retry exhausted');
  }

  #connection(): DatabaseConnection {
    return this.#client ?? this.#pool;
  }
}
