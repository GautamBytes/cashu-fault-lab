import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  acceptDelivery,
  CryptoEnvelope,
  type ExactSwapPlan,
  OutboxPublisher,
  PostgresReceiverStore,
  RecoveryWorker,
  type ReceiverStore,
  type RestoreResult,
  type SwapResult,
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

class BlockingMint extends FakeMint {
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  override async swap(plan: ExactSwapPlan): Promise<SwapResult> {
    this.swapCalls += 1;
    if (this.swapCalls === 1) {
      this.started.resolve();
      await this.release.promise;
    }
    const result = {
      replacementPlanHash: `replacement:${plan.deliveryId}`,
      replacementProofs: [`proof:${plan.deliveryId}`],
    };
    this.committed.set(plan.deliveryId, result);
    return result;
  }
}

class BlockingRestoreMint extends FakeMint {
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  restoreCalls = 0;

  override async restore(plan: ExactSwapPlan): Promise<RestoreResult> {
    this.restoreCalls += 1;
    if (this.restoreCalls === 1) {
      this.started.resolve();
      await this.release.promise;
    }
    return super.restore(plan);
  }
}

class GateBeforeFirstRedemptionLockStore extends PostgresReceiverStore {
  readonly firstCallWaiting = Promise.withResolvers<void>();
  readonly releaseFirstCall = Promise.withResolvers<void>();
  #calls = 0;

  override async withRedemptionLock<T>(
    deliveryId: string,
    operation: (lockedStore: ReceiverStore) => Promise<T>,
  ): Promise<{ readonly acquired: false } | { readonly acquired: true; readonly value: T }> {
    this.#calls += 1;
    if (this.#calls === 1) {
      this.firstCallWaiting.resolve();
      await this.releaseFirstCall.promise;
    }
    return super.withRedemptionLock(deliveryId, operation);
  }
}

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
    await fixture.pool.query(
      "UPDATE deliveries SET updated_at = now() - interval '31 seconds' WHERE delivery_id = $1",
      [deliveryId],
    );
    expect(await worker.runOnce()).toBe(1);
    expect((await restartedStore.current(deliveryId))?.receipt.status).toBe('settled');
    expect(await restartedStore.credits()).toHaveLength(1);
    expect(await worker.runOnce()).toBe(0);
    expect(await restartedStore.credits()).toHaveLength(1);
  });

  it('resumes a durably prepared delivery after restart before mint dispatch', async () => {
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
    const verifier = new FakeProofVerifier();
    const candidate = payload(requestId, deliveryId, now);
    const inspected = await verifier.inspect({ payload: candidate });
    const plan = await mint.prepareSwap({
      version: 1,
      deliveryId: candidate.delivery.id,
      mint: candidate.mint,
      unit: candidate.unit,
      expectedAmount: inspected.netAmount,
      inputProofs: candidate.proofs,
      proofYs: inspected.ys,
    });
    await firstStore.prepare({
      command: { payload: candidate, payloadHash: 'a'.repeat(64) },
      proofSetHash: inspected.proofSetHash,
      proofClaimIds: inspected.proofClaimIds,
      proofYs: inspected.ys,
      netAmount: inspected.netAmount,
      plan,
      now,
    });
    expect((await firstStore.current(deliveryId))?.phase).toBe('prepared');
    await fixture.pool.query(
      "UPDATE deliveries SET updated_at = now() - interval '31 seconds' WHERE delivery_id = $1",
      [deliveryId],
    );

    const restartedStore = new PostgresReceiverStore(fixture.pool, new CryptoEnvelope(key));
    const worker = new RecoveryWorker({
      store: restartedStore,
      mint,
      verifier,
      now: () => now,
    });

    expect(await worker.runOnce()).toBe(1);
    expect(mint.swapCalls).toBe(1);
    expect((await restartedStore.current(deliveryId))?.receipt.status).toBe('settled');
    expect(await restartedStore.credits()).toHaveLength(1);
  });

  it('re-reads terminal state after waiting to acquire the redemption lock', async () => {
    const store = new GateBeforeFirstRedemptionLockStore(fixture.pool, new CryptoEnvelope(key));
    await store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
    const mint = new FakeMint();
    const verifier = new FakeProofVerifier();
    const live = acceptDelivery(
      { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) },
      { store, mint, verifier, now: () => now },
    );
    await store.firstCallWaiting.promise;
    await fixture.pool.query(
      "UPDATE deliveries SET updated_at = now() - interval '31 seconds' WHERE delivery_id = $1",
      [deliveryId],
    );

    const worker = new RecoveryWorker({ store, mint, verifier, now: () => now });
    let recovered = -1;
    try {
      recovered = await worker.runOnce();
    } finally {
      store.releaseFirstCall.resolve();
    }

    expect(recovered).toBe(1);
    await expect(live).resolves.toMatchObject({ status: 'settled' });
    expect(mint.swapCalls).toBe(1);
    expect(await store.credits()).toHaveLength(1);
  });

  it('settles while the PostgreSQL pool is limited to one connection', async () => {
    const pool = new Pool({
      connectionString: fixture.container.getConnectionUri(),
      max: 1,
      connectionTimeoutMillis: 1_000,
    });
    try {
      const store = new PostgresReceiverStore(pool, new CryptoEnvelope(key));
      await store.createRequest({
        id: requestId,
        amount: 8,
        unit: 'sat',
        mints: ['https://mint.example'],
        singleUse: true,
        expiresAt: now + 900,
      });

      await expect(
        acceptDelivery(
          { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) },
          { store, mint: new FakeMint(), verifier: new FakeProofVerifier(), now: () => now },
        ),
      ).resolves.toMatchObject({ status: 'settled' });
      expect(await store.credits()).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it('does not redispatch an in-flight swap after its recovery timestamp becomes stale', async () => {
    const store = new PostgresReceiverStore(fixture.pool, new CryptoEnvelope(key));
    await store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
    const mint = new BlockingMint();
    const verifier = new FakeProofVerifier();
    const live = acceptDelivery(
      { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) },
      { store, mint, verifier, now: () => now },
    );
    await mint.started.promise;
    await fixture.pool.query(
      "UPDATE deliveries SET updated_at = now() - interval '31 seconds' WHERE delivery_id = $1",
      [deliveryId],
    );

    const worker = new RecoveryWorker({ store, mint, verifier, now: () => now });
    let recovered: number;
    try {
      recovered = await worker.runOnce();
    } finally {
      mint.release.resolve();
      await live;
    }

    expect(recovered).toBe(0);
    expect(mint.swapCalls).toBe(1);
    expect(await store.credits()).toHaveLength(1);
  });

  it('leases stale mint recovery to one worker', async () => {
    const store = new PostgresReceiverStore(fixture.pool, new CryptoEnvelope(key));
    await store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
    const mint = new BlockingRestoreMint();
    const verifier = new FakeProofVerifier();
    const candidate = payload(requestId, deliveryId, now);
    const inspected = await verifier.inspect({ payload: candidate });
    const plan = await mint.prepareSwap({
      version: 1,
      deliveryId: candidate.delivery.id,
      mint: candidate.mint,
      unit: candidate.unit,
      expectedAmount: inspected.netAmount,
      inputProofs: candidate.proofs,
      proofYs: inspected.ys,
    });
    await store.prepare({
      command: { payload: candidate, payloadHash: 'a'.repeat(64) },
      proofSetHash: inspected.proofSetHash,
      proofClaimIds: inspected.proofClaimIds,
      proofYs: inspected.ys,
      netAmount: inspected.netAmount,
      plan,
      now,
    });
    await store.markMintSent(deliveryId);
    mint.committed.set(deliveryId, {
      replacementPlanHash: `replacement:${deliveryId}`,
      replacementProofs: [`proof:${deliveryId}`],
    });
    await fixture.pool.query(
      "UPDATE deliveries SET updated_at = now() - interval '31 seconds' WHERE delivery_id = $1",
      [deliveryId],
    );
    const first = new RecoveryWorker({ store, mint, verifier, now: () => now });
    const second = new RecoveryWorker({ store, mint, verifier, now: () => now });

    const firstRun = first.runOnce();
    await mint.started.promise;
    await fixture.pool.query(
      "UPDATE deliveries SET updated_at = now() - interval '31 seconds' WHERE delivery_id = $1",
      [deliveryId],
    );
    let secondCount: number;
    try {
      secondCount = await second.runOnce();
    } finally {
      mint.release.resolve();
    }

    expect(secondCount).toBe(0);
    expect(await firstRun).toBe(1);
    expect(mint.swapCalls).toBe(0);
    expect(mint.restoreCalls).toBe(1);
    expect(await store.credits()).toHaveLength(1);
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
