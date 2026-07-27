import { describe, expect, it } from 'vitest';
import {
  CrashBoundaryHit,
  createOneShotCrashCheckpoint,
  noopCrashCheckpoint,
  senderCrashBoundaries,
  receiverCrashBoundaries,
} from '../src/index.js';

describe('crash checkpoints', () => {
  it('exports the named sender and receiver crash boundaries', () => {
    expect(senderCrashBoundaries).toEqual([
      'sender_before_proof_reservation',
      'sender_after_reservation_before_payload_persistence',
      'sender_after_payload_persistence_before_network_send',
      'sender_after_send_before_response',
    ]);
    expect(receiverCrashBoundaries).toHaveLength(6);
    expect(new Set([...senderCrashBoundaries, ...receiverCrashBoundaries]).size).toBe(10);
  });

  it('provides no-op production and one-shot lab checkpoint implementations', async () => {
    await expect(
      noopCrashCheckpoint.hit('sender_before_proof_reservation', 'delivery-a'),
    ).resolves.toBeUndefined();

    const checkpoint = createOneShotCrashCheckpoint({
      boundary: 'sender_after_payload_persistence_before_network_send',
      occurrence: 2,
    });

    await expect(
      checkpoint.hit('sender_after_payload_persistence_before_network_send', 'delivery-a'),
    ).resolves.toBeUndefined();
    await expect(
      checkpoint.hit('sender_after_payload_persistence_before_network_send', 'delivery-a'),
    ).rejects.toMatchObject({
      boundary: 'sender_after_payload_persistence_before_network_send',
      deliveryId: 'delivery-a',
    });
    await expect(
      checkpoint.hit('sender_after_payload_persistence_before_network_send', 'delivery-a'),
    ).resolves.toBeUndefined();
    expect(() => new CrashBoundaryHit('receiver_before_mint_request', 'delivery-b')).not.toThrow();
  });
});
