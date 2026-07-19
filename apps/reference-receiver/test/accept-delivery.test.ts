import { describe, expect, it } from 'vitest';
import {
  acceptDelivery,
  MemoryReceiverStore,
  ReceiverDomainError,
  recoverDelivery,
} from '../src/index.js';
import { FakeMint, FakeProofVerifier, expectSettled, payload } from './fakes.js';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const otherDeliveryId = 'ICEiIyQlJicoKSorLC0uLw';

async function fixture(singleUse = true) {
  const store = new MemoryReceiverStore();
  await store.createRequest({
    id: requestId,
    amount: 8,
    unit: 'sat',
    mints: ['https://mint.example'],
    singleUse,
    expiresAt: now + 900,
  });
  return { store, mint: new FakeMint(), verifier: new FakeProofVerifier() };
}

describe('acceptDelivery', () => {
  it('persists a plan before mint use and atomically settles one credit', async () => {
    const deps = await fixture();
    const receipt = await acceptDelivery(
      { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) },
      { ...deps, now: () => now },
    );

    expectSettled(receipt);
    expect(receipt).toMatchObject({
      requestId,
      deliveryId,
      amount: 8,
      status: 'settled',
      detailCode: 'settled',
    });
    expect(deps.mint.swapCalls).toBe(1);
    expect(await deps.store.settlementPlans()).toHaveLength(1);
    expect(await deps.store.credits()).toHaveLength(1);
    expect((await deps.store.credits())[0]).toMatchObject({ requestId, deliveryId, amount: 8 });
  });

  it('returns the stored receipt for an exact retry', async () => {
    const deps = await fixture();
    const command = { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) };
    const first = await acceptDelivery(command, { ...deps, now: () => now });
    const duplicate = await acceptDelivery(command, { ...deps, now: () => now });

    expect(duplicate).toEqual(first);
    expect(deps.mint.swapCalls).toBe(1);
    expect(await deps.store.credits()).toHaveLength(1);
  });

  it('rejects delivery ID mutation and proof reuse under another delivery', async () => {
    const deps = await fixture(false);
    await acceptDelivery(
      { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) },
      { ...deps, now: () => now },
    );

    await expect(
      acceptDelivery(
        { payload: payload(requestId, deliveryId, now), payloadHash: 'b'.repeat(64) },
        { ...deps, now: () => now },
      ),
    ).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' });
    await expect(
      acceptDelivery(
        { payload: payload(requestId, otherDeliveryId, now), payloadHash: 'c'.repeat(64) },
        { ...deps, now: () => now },
      ),
    ).rejects.toMatchObject({ code: 'PROOF_CONFLICT' });
  });

  it('enforces single-use requests even with a different proof set', async () => {
    const deps = await fixture(true);
    await acceptDelivery(
      { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) },
      { ...deps, now: () => now },
    );
    const other = payload(requestId, otherDeliveryId, now, {
      proofs: [{ amount: 8, id: '00aa', secret: 'secret-b', C: '03bb' }],
    });
    await expect(
      acceptDelivery({ payload: other, payloadHash: 'b'.repeat(64) }, { ...deps, now: () => now }),
    ).rejects.toMatchObject({ code: 'SINGLE_USE_CONFLICT' });
  });

  it('rejects amount, unit, mint, and expiry mismatches before mint use', async () => {
    const cases = [
      payload(requestId, deliveryId, now, {
        proofs: [{ amount: 7, id: '00aa', secret: 'secret-a', C: '02aa' }],
      }),
      payload(requestId, deliveryId, now, { unit: 'usd' }),
      payload(requestId, deliveryId, now, { mint: 'https://other.example' }),
      payload(requestId, deliveryId, now, {
        delivery: {
          version: 1,
          id: deliveryId,
          createdAt: now - 1_000,
          expiresAt: now - 61,
        },
      }),
    ];
    for (const candidate of cases) {
      const deps = await fixture();
      await expect(
        acceptDelivery(
          { payload: candidate, payloadHash: 'a'.repeat(64) },
          { ...deps, now: () => now },
        ),
      ).rejects.toBeInstanceOf(ReceiverDomainError);
      expect(deps.mint.swapCalls).toBe(0);
      expect(await deps.store.settlementPlans()).toHaveLength(0);
    }
  });

  it('applies 60-second clock skew and rejects later future creation', async () => {
    const store = new MemoryReceiverStore();
    await store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: false,
      expiresAt: now - 60,
    });
    const mint = new FakeMint();
    const verifier = new FakeProofVerifier();
    const withinSkew = payload(requestId, deliveryId, now, {
      delivery: {
        version: 1,
        id: deliveryId,
        createdAt: now - 900,
        expiresAt: now - 60,
      },
    });
    expectSettled(
      await acceptDelivery(
        { payload: withinSkew, payloadHash: 'a'.repeat(64) },
        { store, mint, verifier, now: () => now },
      ),
    );

    const futureDeps = await fixture(false);
    const future = payload(requestId, otherDeliveryId, now, {
      delivery: {
        version: 1,
        id: otherDeliveryId,
        createdAt: now + 61,
        expiresAt: now + 900,
      },
      proofs: [{ amount: 8, id: '00aa', secret: 'secret-b', C: '03bb' }],
    });
    await expect(
      acceptDelivery(
        { payload: future, payloadHash: 'b'.repeat(64) },
        { ...futureDeps, now: () => now },
      ),
    ).rejects.toMatchObject({ code: 'DELIVERY_TIME_INVALID' });
  });

  it('keeps ambiguous consumption recovery-blocked, then restores and settles', async () => {
    const deps = await fixture();
    deps.mint.mode = 'timeout_after_commit';
    const command = { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) };
    const blocked = await acceptDelivery(command, { ...deps, now: () => now });
    expect(blocked).toMatchObject({ status: 'processing', detailCode: 'recovery_blocked' });
    expect(await deps.store.credits()).toHaveLength(0);

    deps.mint.mode = 'success';
    const recovered = await recoverDelivery(deliveryId, { ...deps, now: () => now });
    expectSettled(recovered);
    expect(await deps.store.credits()).toHaveLength(1);
  });

  it('safely rejects pre-commit timeouts and releases claims', async () => {
    const deps = await fixture(false);
    deps.mint.mode = 'timeout_before_commit';
    const rejected = await acceptDelivery(
      { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) },
      { ...deps, now: () => now },
    );
    expect(rejected.status).toBe('rejected');

    deps.mint.mode = 'success';
    const retry = await acceptDelivery(
      { payload: payload(requestId, otherDeliveryId, now), payloadHash: 'b'.repeat(64) },
      { ...deps, now: () => now },
    );
    expectSettled(retry);
  });

  it('cannot settle a prepared plan before mint dispatch is durable', async () => {
    const deps = await fixture(false);
    const candidate = payload(requestId, deliveryId, now);
    const inspected = await deps.verifier.inspect({ payload: candidate });
    await deps.store.prepare({
      command: { payload: candidate, payloadHash: 'a'.repeat(64) },
      proofSetHash: inspected.proofSetHash,
      proofClaimIds: inspected.proofClaimIds,
      proofYs: inspected.ys,
      netAmount: inspected.netAmount,
      plan: {
        version: 1,
        deliveryId: candidate.delivery.id,
        mint: candidate.mint,
        unit: candidate.unit,
        expectedAmount: inspected.netAmount,
        inputProofs: candidate.proofs,
        proofYs: inspected.ys,
        outputDerivation: { strategy: 'delivery-id-v1', counter: 0 },
      },
      now,
    });

    await expect(
      deps.store.settle({
        deliveryId,
        replacementPlanHash: 'replacement-a',
        replacementProofs: ['proof-a'],
        now,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await deps.store.credits()).toHaveLength(0);
  });
});
