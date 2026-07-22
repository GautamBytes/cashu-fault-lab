import {
  parseProtocolId,
  serializeDeliveryPayload,
  type CashuProof,
  type DeliveryPayload,
} from '@cashu-fault-lab/delivery-core';
import { wrapDelivery } from '@cashu-fault-lab/nostr-delivery';
import {
  MemoryReceiverStore,
  type MintGateway,
  type ProofVerifier,
  type SwapPlanDraft,
} from '@cashu-fault-lab/reference-receiver';
import { getPublicKey, type Event } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { CashuTsNostrReceiver } from '../src/nostr-receiver.js';

const now = 1_784_399_400;
const mintUrl = 'https://mint.example';
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const senderKey = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const receiverKey = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const proof: CashuProof = {
  amount: 8,
  id: '00aa',
  secret: 'nostr-receiver-proof-secret',
  C: `02${'11'.repeat(32)}`,
};

class Verifier implements ProofVerifier {
  async inspect(): Promise<Awaited<ReturnType<ProofVerifier['inspect']>>> {
    return {
      ys: [`02${'01'.repeat(32)}`],
      proofClaimIds: ['a'.repeat(64)],
      proofSetHash: 'b'.repeat(64),
      netAmount: 8,
    };
  }
}

class FlakyPrepareMint implements MintGateway {
  prepareCalls = 0;

  async prepareSwap(
    draft: SwapPlanDraft,
  ): Promise<Awaited<ReturnType<MintGateway['prepareSwap']>>> {
    this.prepareCalls += 1;
    if (this.prepareCalls === 1) throw new Error('temporary mint outage');
    return {
      ...draft,
      serializedRequest: '{"swap":true}',
      keysetId: '00aa',
      inputFeePpk: 0,
      outputs: [{ amount: 8, id: '00aa', B_: 'B', secret: 's', blindingFactor: '0'.repeat(64) }],
      preparedAt: now,
      recovery: { nut09: true, nut19Replay: true, nut19ReplayUntil: null },
    };
  }

  async swap(): Promise<Awaited<ReturnType<MintGateway['swap']>>> {
    return { replacementPlanHash: 'c'.repeat(64), replacementProofs: ['replacement-proof'] };
  }

  async restore(): Promise<Awaited<ReturnType<MintGateway['restore']>>> {
    return { kind: 'not_found' };
  }

  async proofStates(): Promise<Awaited<ReturnType<MintGateway['proofStates']>>> {
    return ['SPENT'];
  }
}

function payload(): DeliveryPayload {
  return {
    id: parseProtocolId(requestId),
    memo: null,
    mint: mintUrl,
    unit: 'sat',
    proofs: [proof],
    delivery: {
      version: 1,
      id: parseProtocolId(deliveryId),
      createdAt: now,
      expiresAt: now + 900,
    },
  };
}

describe('CashuTsNostrReceiver', () => {
  it('retries relay history events after transient receiver processing failures', async () => {
    const store = new MemoryReceiverStore();
    const mint = new FlakyPrepareMint();
    await store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: [mintUrl],
      singleUse: true,
      expiresAt: now + 900,
    });
    const requestEvent = wrapDelivery(serializeDeliveryPayload(payload()), {
      senderPrivateKey: senderKey,
      receiverPublicKey: getPublicKey(receiverKey),
      now,
      relayUrl: 'wss://relay.example',
    });
    const published: Event[] = [];
    const receiver = new CashuTsNostrReceiver({
      receiverPrivateKey: receiverKey,
      relayUrls: ['wss://relay.example'],
      accept: { store, mint, verifier: new Verifier(), now: () => now },
      now: () => now,
      source: () => ({ query: async () => [requestEvent] }),
      publish: async (_relayUrl, event) => {
        published.push(event);
        return { accepted: true, message: '' };
      },
    });

    await receiver.poll();
    expect(published).toHaveLength(0);
    expect(mint.prepareCalls).toBe(1);

    await receiver.poll();
    expect(published).toHaveLength(1);
    expect(mint.prepareCalls).toBe(2);
    await expect(store.current(deliveryId)).resolves.toMatchObject({ phase: 'settled' });
  });
});
