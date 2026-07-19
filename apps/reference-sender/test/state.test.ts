import type { ProtocolId } from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import { InMemorySenderState } from '../src/index.js';

const deliveryId = 'EBESExQVFhcYGRobHB0eHw' as ProtocolId;

describe('InMemorySenderState delivery lock', () => {
  it('rejects nested delivery-lock acquisition instead of deadlocking', async () => {
    const state = new InMemorySenderState();

    const nested = state.withDeliveryLock(deliveryId, async () =>
      state.withDeliveryLock(deliveryId, async () => undefined),
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Nested lock acquisition deadlocked')), 50);
    });

    await expect(Promise.race([nested, timeout])).rejects.toThrowError(/nested/i);
  });
});
