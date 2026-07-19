import {
  computePayloadHash,
  parseDeliveryPayloadJson,
  serializeDeliveryPayload,
  serializeDeliveryReceipt,
  type DeliveryPayload,
  type ProtocolId,
} from '@cashu-fault-lab/delivery-core';
import {
  NostrRelayClient,
  unwrapDelivery,
  wrapDelivery,
  type GiftWrapFilter,
  type GiftWrapSource,
  type RelayPublishResult,
} from '@cashu-fault-lab/nostr-delivery';
import { getPublicKey, nip19 } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { NostrPaymentTransport } from '../src/index.js';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const senderKey = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const receiverKey = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const relayUrl = 'wss://relay.example';
const target = {
  type: 'nostr' as const,
  target: nip19.nprofileEncode({ pubkey: getPublicKey(receiverKey), relays: [relayUrl] }),
  tags: [['n', '17']] as const,
};

function payloadBytes(): Uint8Array {
  const payload: DeliveryPayload = {
    id: requestId as ProtocolId,
    memo: null,
    mint: 'https://mint.example',
    unit: 'sat',
    proofs: [{ amount: 8, id: '00aa', secret: 'secret-a', C: '02aa' }],
    delivery: {
      version: 1,
      id: deliveryId as ProtocolId,
      createdAt: now,
      expiresAt: now + 900,
    },
  };
  return serializeDeliveryPayload(payload);
}

function receiptReply(
  requestWrap: Parameters<NostrRelayClient['publish']>[0],
): ReturnType<typeof wrapDelivery> {
  const payload = parseDeliveryPayloadJson(
    unwrapDelivery(requestWrap, receiverKey).payloadBytes,
    now,
  );
  const payloadHash = computePayloadHash({
    requestId: payload.id,
    memo: payload.memo,
    mint: payload.mint,
    unit: payload.unit,
    proofs: payload.proofs,
    createdAt: payload.delivery.createdAt,
    expiresAt: payload.delivery.expiresAt,
  });
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      serializeDeliveryReceipt({
        profile: 'cashu-delivery-v1',
        requestId: payload.id,
        deliveryId: payload.delivery.id,
        payloadHash,
        status: 'settled',
        statusVersion: 1,
        mint: payload.mint,
        unit: payload.unit,
        amount: 8,
        detailCode: 'settled',
      }),
    ),
  );
  return wrapDelivery(bytes, {
    senderPrivateKey: receiverKey,
    receiverPublicKey: getPublicKey(senderKey),
    now,
    randomSecretKey: () => Uint8Array.from(Buffer.from('77'.repeat(32), 'hex')),
    randomOffsetSeconds: () => 1,
  });
}

describe('NostrPaymentTransport', () => {
  it('requires an encrypted receipt instead of treating relay OK as payment success', async () => {
    const transport = new NostrPaymentTransport({
      senderPrivateKey: senderKey,
      now: () => now,
      publish: async (): Promise<RelayPublishResult> => ({ accepted: true, message: '' }),
      source: (): GiftWrapSource => ({ query: async (_filter: GiftWrapFilter) => [] }),
      pollAttempts: 1,
    });

    await expect(
      transport.send(payloadBytes(), target, new AbortController().signal),
    ).resolves.toEqual({ kind: 'no_response' });
  });

  it('freshly wraps each retry and accepts only a verified receipt reply', async () => {
    const published: Array<Parameters<NostrRelayClient['publish']>[0]> = [];
    let reply: ReturnType<typeof wrapDelivery> | undefined;
    const wrapperKeys = ['33', '44'].map((byte) =>
      Uint8Array.from(Buffer.from(byte.repeat(32), 'hex')),
    );
    const transport = new NostrPaymentTransport({
      senderPrivateKey: senderKey,
      now: () => now,
      publish: async (_url, event): Promise<RelayPublishResult> => {
        published.push(event);
        reply = receiptReply(event);
        return { accepted: true, message: '' };
      },
      source: (): GiftWrapSource => ({
        query: async (_filter: GiftWrapFilter) => (reply ? [reply] : []),
      }),
      pollAttempts: 1,
      randomSecretKey: () => wrapperKeys.shift()!,
      randomOffsetSeconds: () => 1,
    });

    const first = await transport.send(payloadBytes(), target, new AbortController().signal);
    const second = await transport.send(payloadBytes(), target, new AbortController().signal);

    expect(first).toMatchObject({ kind: 'receipt', receipt: { delivery_id: deliveryId } });
    expect(second).toEqual(first);
    expect(new Set(published.map((event) => event.pubkey)).size).toBe(2);
    expect(
      published.map((event) =>
        Buffer.from(unwrapDelivery(event, receiverKey).payloadBytes).toString('hex'),
      ),
    ).toEqual([
      Buffer.from(payloadBytes()).toString('hex'),
      Buffer.from(payloadBytes()).toString('hex'),
    ]);
  });
});
