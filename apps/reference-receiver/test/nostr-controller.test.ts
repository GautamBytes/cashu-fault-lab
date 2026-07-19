import { parseDeliveryReceipt, serializeDeliveryPayload } from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import { unwrapDelivery, wrapDelivery } from '../../../packages/nostr-delivery/src/index.js';
import { MemoryReceiverStore, processNostrDelivery } from '../src/index.js';
import { FakeMint, FakeProofVerifier, payload } from './fakes.js';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const senderKey = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const receiverKey = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const receiverPublicKey = '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27';

describe('Nostr receiver controller', () => {
  it('returns a NIP-17 receipt and deduplicates fresh wrappers around identical inner bytes', async () => {
    const store = new MemoryReceiverStore();
    const mint = new FakeMint();
    await store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
    const payloadBytes = serializeDeliveryPayload(payload(requestId, deliveryId, now));
    const dependencies = { store, mint, verifier: new FakeProofVerifier(), now: () => now };

    for (const [incomingByte, replyByte] of [
      ['33', '55'],
      ['44', '66'],
    ] as const) {
      const incoming = wrapDelivery(payloadBytes, {
        senderPrivateKey: senderKey,
        receiverPublicKey,
        now,
        randomSecretKey: () => Uint8Array.from(Buffer.from(incomingByte.repeat(32), 'hex')),
        randomOffsetSeconds: () => 1,
      });
      const reply = await processNostrDelivery(incoming, {
        receiverPrivateKey: receiverKey,
        accept: dependencies,
        randomSecretKey: () => Uint8Array.from(Buffer.from(replyByte.repeat(32), 'hex')),
        randomOffsetSeconds: () => 1,
      });
      const receiptBytes = unwrapDelivery(reply, senderKey).payloadBytes;
      const receipt = parseDeliveryReceipt(JSON.parse(new TextDecoder().decode(receiptBytes)));
      expect(receipt).toMatchObject({
        requestId,
        deliveryId,
        status: 'settled',
      });
    }

    expect(mint.swapCalls).toBe(1);
    expect(await store.credits()).toHaveLength(1);
  });
});
