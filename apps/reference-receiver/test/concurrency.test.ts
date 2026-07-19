import { describe, expect, it } from 'vitest';
import { acceptDelivery, MemoryReceiverStore } from '../src/index.js';
import { FakeMint, FakeProofVerifier, payload } from './fakes.js';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';

describe('receiver concurrency', () => {
  it('turns 100 concurrent duplicates into one plan, swap, and credit', async () => {
    const store = new MemoryReceiverStore();
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
    const command = { payload: payload(requestId, deliveryId, now), payloadHash: 'a'.repeat(64) };

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        acceptDelivery(command, { store, mint, verifier, now: () => now }),
      ),
    );

    expect(new Set(results.map((result) => result.deliveryId))).toEqual(new Set([deliveryId]));
    expect(mint.swapCalls).toBe(1);
    expect(await store.settlementPlans()).toHaveLength(1);
    expect(await store.credits()).toHaveLength(1);
    expect((await store.current(deliveryId))?.receipt.status).toBe('settled');
  });

  it('allows only one winner for concurrent single-use deliveries', async () => {
    const store = new MemoryReceiverStore();
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
    const deliveries = Array.from({ length: 20 }, (_, index) => {
      const bytes = Buffer.alloc(16, index + 1).toString('base64url');
      return acceptDelivery(
        {
          payload: payload(requestId, bytes, now, {
            proofs: [{ amount: 8, id: '00aa', secret: `secret-${index}`, C: '02aa' }],
          }),
          payloadHash: index.toString(16).padStart(64, '0'),
        },
        { store, mint, verifier, now: () => now },
      );
    });

    const results = await Promise.allSettled(deliveries);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(19);
    expect(mint.swapCalls).toBe(1);
    expect(await store.credits()).toHaveLength(1);
  });
});
