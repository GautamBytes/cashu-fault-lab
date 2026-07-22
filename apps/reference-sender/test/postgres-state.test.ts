import type {
  CashuProof,
  DeliveryPayload,
  DeliveryReceipt,
  ProtocolId,
} from '@cashu-fault-lab/delivery-core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgresSenderState,
  migratePostgresSenderState,
  type SenderDeliveryRecord,
} from '../src/index.js';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw' as ProtocolId;
const deliveryId = 'EBESExQVFhcYGRobHB0eHw' as ProtocolId;
const payloadHash = 'a'.repeat(64);
const stateKey = Buffer.alloc(32, 7);
const proofs: readonly CashuProof[] = [
  { amount: 8, id: '00aa', secret: 'sender-postgres-secret', C: '02aa' },
];

function payload(): DeliveryPayload {
  return {
    id: requestId,
    memo: null,
    mint: 'https://mint.example',
    unit: 'sat',
    proofs,
    delivery: { version: 1, id: deliveryId, createdAt: now, expiresAt: now + 900 },
  };
}

function receipt(): DeliveryReceipt {
  return {
    profile: 'cashu-delivery-v1',
    requestId,
    deliveryId,
    payloadHash,
    status: 'settled',
    statusVersion: 2,
    mint: 'https://mint.example',
    unit: 'sat',
    amount: 8,
    detailCode: 'settled',
  };
}

function record(overrides: Partial<SenderDeliveryRecord> = {}): SenderDeliveryRecord {
  return {
    deliveryId,
    request: {
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      expiresAt: now + 900,
      transports: [{ type: 'post', target: 'https://merchant.example/v1/pay' }],
    },
    payload: payload(),
    payloadBytes: Uint8Array.from([0, 1, 2, 253, 254, 255]),
    payloadHash,
    target: { type: 'post', target: 'https://merchant.example/v1/pay' },
    status: 'sending',
    attempts: 1,
    ...overrides,
  };
}

describe('PostgresSenderState', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('cashu_fault_lab')
      .withUsername('cashu')
      .withPassword('cashu-test-password')
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
    await migratePostgresSenderState(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool?.query('TRUNCATE sender_deliveries');
  });

  afterAll(async () => {
    pool?.on('error', () => {});
    await pool?.end();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await container?.stop();
  }, 30_000);

  it('survives reconstruction and preserves payload bytes', async () => {
    if (pool === undefined) throw new Error('PostgreSQL pool did not start');
    const first = new PostgresSenderState({ pool, encryptionKey: stateKey });
    await first.create(record());
    await first.save(record({ attempts: 2, status: 'settled', receipt: receipt() }));

    const raw = await pool.query<{ record_ciphertext: Buffer }>(
      'SELECT record_ciphertext FROM sender_deliveries WHERE delivery_id = $1',
      [deliveryId],
    );
    expect(raw.rows[0]?.record_ciphertext.includes(Buffer.from('sender-postgres-secret'))).toBe(
      false,
    );

    const restarted = new PostgresSenderState({ pool, encryptionKey: stateKey });
    const stored = await restarted.get(deliveryId);

    expect(stored).toMatchObject({ deliveryId, status: 'settled', attempts: 2 });
    expect(stored?.receipt).toEqual(receipt());
    expect(stored?.payloadBytes).toEqual(Uint8Array.from([0, 1, 2, 253, 254, 255]));
  });

  it('serializes same-delivery locks across separate state instances', async () => {
    if (pool === undefined) throw new Error('PostgreSQL pool did not start');
    const first = new PostgresSenderState({ pool, encryptionKey: stateKey });
    const second = new PostgresSenderState({ pool, encryptionKey: stateKey });
    const order: string[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstLock = first.withDeliveryLock(deliveryId, async (state) => {
      order.push('first-start');
      markStarted();
      await state.create(record());
      await holdFirst;
      order.push('first-end');
    });
    await started;
    const secondLock = second.withDeliveryLock(deliveryId, async (state) => {
      order.push('second-start');
      const stored = await state.get(deliveryId);
      if (stored === undefined) throw new Error('Delivery was not visible after lock handoff');
      await state.save({ ...stored, attempts: 2 });
      order.push('second-end');
    });
    await Promise.resolve();

    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([firstLock, secondLock]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    await expect(first.get(deliveryId)).resolves.toMatchObject({ attempts: 2 });
  });

  it('rejects nested delivery-lock acquisition instead of deadlocking', async () => {
    if (pool === undefined) throw new Error('PostgreSQL pool did not start');
    const state = new PostgresSenderState({ pool, encryptionKey: stateKey });

    await expect(
      state.withDeliveryLock(deliveryId, async () =>
        state.withDeliveryLock(deliveryId, async () => undefined),
      ),
    ).rejects.toThrowError(/nested/i);
  });
});
