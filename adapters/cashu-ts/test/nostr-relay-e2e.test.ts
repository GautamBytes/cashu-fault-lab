import { HttpAdapterClient } from '@cashu-fault-lab/adapter-contract';
import {
  computePayloadHash,
  parseProtocolId,
  type CashuProof,
} from '@cashu-fault-lab/delivery-core';
import { NostrFaultRelay } from '@cashu-fault-lab/nostr-fault-relay';
import {
  type MintGateway,
  type ProofVerifier,
  type SwapPlanDraft,
} from '@cashu-fault-lab/reference-receiver';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CashuTsNostrTransport,
  FundedCashuTsDualRoleOperations,
  FundedCashuTsOperations,
  FundedCashuTsReceiverOperations,
  type CashuTsTransportPort,
  type CashuTsWalletPort,
  type ReservedCashuTsProofs,
} from '../src/index.js';
import { buildCashuTsAdapterServer } from '../src/server.js';

const now = 1_784_399_400;
const token = 'nostr-e2e-control-token';
const mintUrl = 'https://mint.example';
const proof: CashuProof = {
  amount: 8,
  id: '00aa',
  secret: 'nostr-relay-proof-secret',
  C: `02${'11'.repeat(32)}`,
};
const senderKey = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const receiverKey = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));

class RelayVerifier implements ProofVerifier {
  async inspect(
    input: Parameters<ProofVerifier['inspect']>[0],
  ): Promise<Awaited<ReturnType<ProofVerifier['inspect']>>> {
    const proofClaimIds = input.payload.proofs.map((candidate) =>
      createHash('sha256').update(`claim:${candidate.secret}`).digest('hex'),
    );
    return {
      ys: input.payload.proofs.map(() => `02${'01'.repeat(32)}`),
      proofClaimIds,
      proofSetHash: createHash('sha256').update(proofClaimIds.join('|')).digest('hex'),
      netAmount: input.payload.proofs.reduce((sum, candidate) => sum + candidate.amount, 0),
    };
  }
}

class RelayMint implements MintGateway {
  swapCalls = 0;

  async prepareSwap(
    draft: SwapPlanDraft,
  ): Promise<Awaited<ReturnType<MintGateway['prepareSwap']>>> {
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
    this.swapCalls += 1;
    return { replacementPlanHash: 'c'.repeat(64), replacementProofs: ['replacement-proof'] };
  }

  async restore(): Promise<Awaited<ReturnType<MintGateway['restore']>>> {
    return { kind: 'not_found' };
  }

  async proofStates(): Promise<Awaited<ReturnType<MintGateway['proofStates']>>> {
    return ['SPENT'];
  }
}

class RelayWallet implements CashuTsWalletPort {
  reserveCalls = 0;
  settledCalls = 0;

  async reset(): Promise<void> {
    this.reserveCalls = 0;
    this.settledCalls = 0;
  }

  async reserve(): Promise<ReservedCashuTsProofs> {
    this.reserveCalls += 1;
    return { mint: mintUrl, proofs: [proof] };
  }

  async markSettled(): Promise<void> {
    this.settledCalls += 1;
  }

  async evidence(
    selectedDeliveryId: string,
  ): Promise<Awaited<ReturnType<CashuTsWalletPort['evidence']>>> {
    return {
      deliveryId: selectedDeliveryId,
      proofSetHash: 'd'.repeat(64),
      inputYs: [`02${'01'.repeat(32)}`],
      state: 'spent',
    };
  }
}

describe.skipIf(process.env.CFL_NOSTR_RELAY_E2E !== '1')('cashu-ts funded Nostr relay E2E', () => {
  it('settles over a real NIP-17 relay and exposes receiver evidence', async () => {
    const relay = new NostrFaultRelay();
    const relayUrl = await relay.listen();
    const mint = new RelayMint();
    const wallet = new RelayWallet();
    const receiver = new FundedCashuTsReceiverOperations({
      mintUrl,
      mint,
      verifier: new RelayVerifier(),
      receiverNostrPrivateKey: receiverKey,
      nostrRelayUrls: [relayUrl],
      nostrPollIntervalMs: 10,
      nostrTimeoutMs: 1_000,
      now: () => now,
    });
    const operations = new FundedCashuTsDualRoleOperations({
      sender: new FundedCashuTsOperations({
        wallet,
        transport: new CashuTsNostrTransport({
          senderPrivateKey: senderKey,
          now: () => now,
          timeoutMs: 1_000,
          pollAttempts: 100,
          pollDelayMs: 20,
        }) satisfies CashuTsTransportPort,
        supportedTransports: ['nostr'],
        now: () => now,
      }),
      receiver,
    });
    const app = await buildCashuTsAdapterServer({
      testMode: true,
      operations,
      now: () => now,
    });
    receiver.startNostr();
    try {
      const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      const client = new HttpAdapterClient({ baseUrl, token, timeoutMs: 5_000 });
      await client.reset('nostr-relay-e2e');
      const request = await client.createRequest({
        amount: 8,
        unit: 'sat',
        transports: ['nostr'],
        singleUse: true,
        expiresIn: 900,
      });
      const receipt = await client.send({ request: request.raw });
      const parsedPayloadHash = computePayloadHash({
        requestId: parseProtocolId(request.id),
        memo: null,
        mint: mintUrl,
        unit: 'sat',
        proofs: [proof],
        createdAt: now,
        expiresAt: now + 900,
      });

      expect(receipt).toMatchObject({
        request_id: request.id,
        payload_hash: parsedPayloadHash,
        status: 'settled',
      });
      await expect(client.delivery(receipt.delivery_id)).resolves.toEqual(receipt);
      await expect(client.ledger()).resolves.toEqual([
        {
          requestId: request.id,
          deliveryId: receipt.delivery_id,
          amount: 8,
          unit: 'sat',
          creditCount: 1,
          createdAt: now,
        },
      ]);
      await expect(client.proofs()).resolves.toEqual([
        expect.objectContaining({ deliveryId: receipt.delivery_id, state: 'spent' }),
      ]);
      expect(relay.snapshot().storedEvents).toBeGreaterThanOrEqual(2);
      expect(mint.swapCalls).toBe(1);
      expect(wallet.reserveCalls).toBe(1);
      expect(wallet.settledCalls).toBe(1);
    } catch (error) {
      throw error;
    } finally {
      receiver.stopNostr();
      await app.close();
      await relay.close();
    }
  }, 15_000);
});
