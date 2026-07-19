import { describe, expect, it } from 'vitest';
import {
  acceptDelivery,
  MemoryReceiverStore,
  MintGatewayError,
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
  it('treats a request mint set as order-independent', async () => {
    const store = new MemoryReceiverStore();
    const first = await store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint-b.example', 'https://mint-a.example'],
      singleUse: true,
      expiresAt: now + 900,
    });

    await expect(
      store.createRequest({
        id: requestId,
        amount: 8,
        unit: 'sat',
        mints: ['https://mint-a.example', 'https://mint-b.example'],
        singleUse: true,
        expiresAt: now + 900,
      }),
    ).resolves.toEqual(first);
  });

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

  it('returns a settled duplicate without contacting proof or mint services again', async () => {
    const deps = await fixture();
    const command = { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) };
    const first = await acceptDelivery(command, { ...deps, now: () => now });
    deps.verifier.inspect = async () => {
      throw new Error('proof service is offline');
    };
    deps.mint.prepareSwap = async () => {
      throw new Error('mint metadata is offline');
    };

    await expect(acceptDelivery(command, { ...deps, now: () => now })).resolves.toEqual(first);
    expect(deps.mint.swapCalls).toBe(1);
    expect(await deps.store.credits()).toHaveLength(1);
  });

  it('rejects a request mint mismatch before proof or mint network access', async () => {
    const deps = await fixture();
    deps.verifier.inspect = async () => {
      throw new Error('proof service must not be called');
    };
    deps.mint.prepareSwap = async () => {
      throw new Error('mint service must not be called');
    };
    const hostile = payload(requestId, deliveryId, now, {
      mint: 'http://127.0.0.1:7777',
    });

    await expect(
      acceptDelivery(
        { payload: hostile, payloadHash: 'b'.repeat(64) },
        { ...deps, now: () => now },
      ),
    ).rejects.toMatchObject({ code: 'MINT_MISMATCH' });
    expect(await deps.store.settlementPlans()).toHaveLength(0);
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
    deps.verifier.inspect = async () => {
      throw new Error('proof service must not be called for a claimed single-use request');
    };
    deps.mint.prepareSwap = async () => {
      throw new Error('mint service must not be called for a claimed single-use request');
    };
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

  it('rechecks expiry after proof and mint preparation before durable acceptance', async () => {
    const deps = await fixture(false);
    let clock = now;
    const prepareSwap = deps.mint.prepareSwap.bind(deps.mint);
    deps.mint.prepareSwap = async (draft) => {
      const plan = await prepareSwap(draft);
      clock = now + 961;
      return plan;
    };

    await expect(
      acceptDelivery(
        { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) },
        { ...deps, now: () => clock },
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_EXPIRED' });
    expect(deps.mint.swapCalls).toBe(0);
    expect(await deps.store.settlementPlans()).toHaveLength(0);
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

  it('does not reject or release claims when recovery evidence is temporarily unavailable', async () => {
    const deps = await fixture(false);
    deps.mint.mode = 'timeout_after_commit';
    const command = { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) };
    await acceptDelivery(command, { ...deps, now: () => now });
    deps.mint.restore = async () => {
      throw new MintGatewayError('MINT_HTTP_503', 'recovery endpoint unavailable', false);
    };

    await expect(recoverDelivery(deliveryId, { ...deps, now: () => now })).resolves.toMatchObject({
      status: 'processing',
      detailCode: 'recovery_blocked',
    });
    expect((await deps.store.current(deliveryId))?.phase).toBe('recovery_blocked');
    expect(await deps.store.credits()).toHaveLength(0);

    const other = payload(requestId, otherDeliveryId, now, {
      proofs: [{ amount: 8, id: '00aa', secret: 'secret-a', C: '02aa' }],
    });
    await expect(
      acceptDelivery({ payload: other, payloadHash: 'b'.repeat(64) }, { ...deps, now: () => now }),
    ).rejects.toMatchObject({ code: 'PROOF_CONFLICT' });
  });

  it('does not redispatch an ambiguous swap from an unspent state snapshot', async () => {
    const deps = await fixture(false);
    deps.mint.swap = async () => {
      deps.mint.swapCalls += 1;
      throw new MintGatewayError('MINT_TIMEOUT', 'mint request outcome is unknown', true);
    };
    const command = { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) };

    await expect(acceptDelivery(command, { ...deps, now: () => now })).resolves.toMatchObject({
      status: 'processing',
      detailCode: 'recovery_blocked',
    });
    await expect(recoverDelivery(deliveryId, { ...deps, now: () => now })).resolves.toMatchObject({
      status: 'processing',
      detailCode: 'recovery_blocked',
    });

    expect(deps.mint.swapCalls).toBe(1);
    expect(await deps.store.credits()).toHaveLength(0);
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
      plan: await deps.mint.prepareSwap({
        version: 1,
        deliveryId: candidate.delivery.id,
        mint: candidate.mint,
        unit: candidate.unit,
        expectedAmount: inspected.netAmount,
        inputProofs: candidate.proofs,
        proofYs: inspected.ys,
      }),
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
