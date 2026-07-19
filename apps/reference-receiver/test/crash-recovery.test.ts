import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptDelivery,
  CryptoEnvelope,
  OutboxPublisher,
  PostgresReceiverStore,
  RecoveryWorker,
} from '../src/index.js';
import { FakeMint, FakeProofVerifier, payload } from './fakes.js';
import {
  resetPostgres,
  startPostgresFixture,
  stopPostgresFixture,
  type PostgresFixture,
} from './postgres-fixture.js';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const key = Buffer.alloc(32, 9);

let fixture: PostgresFixture;

describe('PostgreSQL crash recovery', () => {
  beforeAll(async () => {
    fixture = await startPostgresFixture();
  }, 120_000);

  beforeEach(async () => {
    await resetPostgres(fixture.pool);
  });

  afterAll(async () => {
    if (fixture) await stopPostgresFixture(fixture);
  });

  it('recovers outputs after mint commit and process replacement, crediting once', async () => {
    const firstStore = new PostgresReceiverStore(fixture.pool, new CryptoEnvelope(key));
    await firstStore.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
    const mint = new FakeMint();
    mint.mode = 'timeout_after_commit';
    const verifier = new FakeProofVerifier();
    const blocked = await acceptDelivery(
      { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) },
      { store: firstStore, mint, verifier, now: () => now },
    );
    expect(blocked).toMatchObject({ status: 'processing', detailCode: 'recovery_blocked' });

    const restartedStore = new PostgresReceiverStore(fixture.pool, new CryptoEnvelope(key));
    mint.mode = 'success';
    const worker = new RecoveryWorker({
      store: restartedStore,
      mint,
      verifier,
      now: () => now,
    });
    expect(await worker.runOnce()).toBe(1);
    expect((await restartedStore.current(deliveryId))?.receipt.status).toBe('settled');
    expect(await restartedStore.credits()).toHaveLength(1);
    expect(await worker.runOnce()).toBe(0);
    expect(await restartedStore.credits()).toHaveLength(1);
  });

  it('publishes the durable outbox at least once and marks rows after success', async () => {
    const store = new PostgresReceiverStore(fixture.pool, new CryptoEnvelope(key));
    await store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
    await acceptDelivery(
      { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) },
      { store, mint: new FakeMint(), verifier: new FakeProofVerifier(), now: () => now },
    );

    const published: unknown[] = [];
    const publisher = new OutboxPublisher(store, async (receipt) => {
      published.push(receipt);
    });
    expect(await publisher.runOnce()).toBe(1);
    expect(await publisher.runOnce()).toBe(0);
    expect(published).toHaveLength(1);
  });
});
