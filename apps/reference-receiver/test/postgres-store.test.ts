import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CryptoEnvelope,
  PostgresReceiverStore,
  type ExactSwapPlan,
  type PrepareDelivery,
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

let fixture: PostgresFixture;
let store: PostgresReceiverStore;

async function prepareInput(
  selectedDeliveryId = deliveryId,
  secret = 'secret-a',
): Promise<PrepareDelivery> {
  const candidate = payload(requestId, selectedDeliveryId, now, {
    proofs: [{ amount: 8, id: '00aa', secret, C: '02aa' }],
  });
  const inspected = await new FakeProofVerifier().inspect({ payload: candidate });
  const plan: ExactSwapPlan = await new FakeMint().prepareSwap({
    version: 1,
    deliveryId: candidate.delivery.id,
    mint: candidate.mint,
    unit: candidate.unit,
    expectedAmount: inspected.netAmount,
    inputProofs: candidate.proofs,
    proofYs: inspected.ys,
  });
  return {
    command: { payload: candidate, payloadHash: 'a'.repeat(64) },
    proofSetHash: inspected.proofSetHash,
    proofClaimIds: inspected.proofClaimIds,
    proofYs: inspected.ys,
    netAmount: inspected.netAmount,
    plan,
    now,
  };
}

describe('PostgresReceiverStore', () => {
  beforeAll(async () => {
    fixture = await startPostgresFixture();
    store = new PostgresReceiverStore(
      fixture.pool,
      new CryptoEnvelope(Buffer.alloc(32, 7), randomBytes),
    );
  }, 120_000);

  beforeEach(async () => {
    await resetPostgres(fixture.pool);
    await store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
  });

  afterAll(async () => {
    if (fixture) await stopPostgresFixture(fixture);
  });

  it('atomically collapses 100 duplicate prepares into one encrypted plan and proof claim', async () => {
    const input = await prepareInput();
    const results = await Promise.all(Array.from({ length: 100 }, () => store.prepare(input)));

    expect(results.filter((result) => result.kind === 'prepared')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'duplicate')).toHaveLength(99);
    expect(
      (await fixture.pool.query('SELECT count(*)::int AS count FROM deliveries')).rows[0],
    ).toMatchObject({ count: 1 });
    expect(
      (await fixture.pool.query('SELECT count(*)::int AS count FROM proof_claims')).rows[0],
    ).toMatchObject({ count: 1 });

    const row = (
      await fixture.pool.query<{
        swap_plan_ciphertext: Buffer;
        swap_plan_nonce: Buffer;
        swap_plan_tag: Buffer;
      }>('SELECT swap_plan_ciphertext, swap_plan_nonce, swap_plan_tag FROM deliveries')
    ).rows[0]!;
    expect(row.swap_plan_ciphertext.includes(Buffer.from('secret-a'))).toBe(false);
    expect(row.swap_plan_nonce).toHaveLength(12);
    expect(row.swap_plan_tag).toHaveLength(16);
    expect((await store.current(deliveryId))?.plan).toEqual(input.plan);
  });

  it('uses database uniqueness for concurrent single-use deliveries', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 30 }, async (_value, index) => {
        const id = Buffer.alloc(16, index + 1).toString('base64url');
        return store.prepare(await prepareInput(id, `secret-${index}`));
      }),
    );
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(29);
    expect(
      (await fixture.pool.query('SELECT count(*)::int AS count FROM deliveries')).rows[0],
    ).toMatchObject({ count: 1 });
  });

  it('atomically settles one merchant credit and one receipt outbox row', async () => {
    const input = await prepareInput();
    await store.prepare(input);
    await store.markMintSent(deliveryId);
    const receipts = await Promise.all(
      Array.from({ length: 50 }, () =>
        store.settle({
          deliveryId,
          replacementPlanHash: 'replacement-a',
          replacementProofs: ['proof-a'],
          now,
        }),
      ),
    );
    expect(new Set(receipts.map((receipt) => receipt.status))).toEqual(new Set(['settled']));
    expect(
      (await fixture.pool.query('SELECT count(*)::int AS count FROM merchant_credits')).rows[0],
    ).toMatchObject({ count: 1 });
    expect(
      (await fixture.pool.query('SELECT count(*)::int AS count FROM receipt_outbox')).rows[0],
    ).toMatchObject({ count: 1 });
    expect(await store.credits()).toHaveLength(1);
  });

  it('authenticates encrypted plans against immutable delivery identity', async () => {
    const input = await prepareInput();
    await store.prepare(input);
    await fixture.pool.query('UPDATE deliveries SET payload_hash = $1 WHERE delivery_id = $2', [
      'b'.repeat(64),
      deliveryId,
    ]);
    await expect(store.current(deliveryId)).rejects.toThrowError(/decrypt|authentic/i);
  });
});
