import { MintQuoteState, Wallet, type Proof } from '@cashu/cashu-ts';
import {
  computePayloadHash,
  type CashuProof,
  type DeliveryPayload,
  type ProtocolId,
} from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import {
  acceptDelivery,
  CashuTsMintGateway,
  CashuTsProofVerifier,
  MemoryReceiverStore,
  recoverDelivery,
  type MintFetch,
} from '../src/index.js';

const mintUrl = process.env.CFL_REAL_MINT_URL;
const now = 1_784_399_400;

function deliveryProof(proof: Proof): CashuProof {
  return {
    amount: proof.amount.toNumber(),
    id: proof.id,
    secret: proof.secret,
    C: proof.C,
    ...(proof.witness === undefined
      ? {}
      : {
          witness:
            typeof proof.witness === 'string' ? proof.witness : JSON.stringify(proof.witness),
        }),
    ...(proof.dleq ? { dleq: { ...proof.dleq } } : {}),
    ...(proof.p2pk_e ? { p2pk_e: proof.p2pk_e } : {}),
  };
}

async function mintTestProofs(url: string): Promise<readonly CashuProof[]> {
  const wallet = new Wallet(url, { unit: 'sat' });
  await wallet.loadMint();
  let quote = await wallet.createMintQuoteBolt11(8, 'cashu-fault-lab integration test');
  for (let attempt = 0; quote.state !== MintQuoteState.PAID && attempt < 60; attempt += 1) {
    quote = await wallet.checkMintQuoteBolt11(quote);
    if (quote.state !== MintQuoteState.PAID) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (quote.state !== MintQuoteState.PAID) throw new Error('Fake mint quote did not become paid');
  return (await wallet.mintProofsBolt11(8, quote)).map(deliveryProof);
}

describe.skipIf(!mintUrl)('real Docker mint settlement recovery', () => {
  it('recovers one merchant credit after a committed NUT-03 response is lost', async () => {
    const url = mintUrl!;
    const proofs = await mintTestProofs(url);
    const verifier = new CashuTsProofVerifier({ proofClaimKey: Buffer.alloc(32, 17) });
    const payloadBase = {
      id: 'AAECAwQFBgcICQoLDA0ODw' as ProtocolId,
      memo: null,
      mint: url,
      unit: 'sat',
      proofs,
      delivery: {
        version: 1 as const,
        id: 'EBESExQVFhcYGRobHB0eHw' as ProtocolId,
        createdAt: now,
        expiresAt: now + 900,
      },
    } satisfies DeliveryPayload;
    const inspected = await verifier.inspect({ payload: payloadBase });
    const store = new MemoryReceiverStore();
    await store.createRequest({
      id: payloadBase.id,
      amount: inspected.netAmount,
      unit: payloadBase.unit,
      mints: [url],
      singleUse: true,
      expiresAt: payloadBase.delivery.expiresAt,
    });

    let loseNextSwapResponse = true;
    const swapBodies: string[] = [];
    const lossyFetch: MintFetch = async (input, init) => {
      const target = new URL(String(input));
      const response = await fetch(input, init);
      if (target.pathname === '/v1/swap' && init?.method === 'POST') {
        swapBodies.push(String(init.body));
        if (loseNextSwapResponse) {
          loseNextSwapResponse = false;
          await response.arrayBuffer();
          throw new Error('fault lab dropped committed swap response');
        }
      }
      return response;
    };
    const gateway = new CashuTsMintGateway({ now: () => now, fetch: lossyFetch });
    const command = {
      payload: payloadBase,
      payloadHash: computePayloadHash({
        requestId: payloadBase.id,
        memo: payloadBase.memo,
        mint: payloadBase.mint,
        unit: payloadBase.unit,
        proofs: payloadBase.proofs,
        createdAt: payloadBase.delivery.createdAt,
        expiresAt: payloadBase.delivery.expiresAt,
      }),
    };

    await expect(
      acceptDelivery(command, { store, mint: gateway, verifier, now: () => now }),
    ).resolves.toMatchObject({ status: 'processing', detailCode: 'recovery_blocked' });
    await expect(
      recoverDelivery(payloadBase.delivery.id, {
        store,
        mint: gateway,
        verifier,
        now: () => now,
      }),
    ).resolves.toMatchObject({ status: 'settled' });

    expect(await store.credits()).toHaveLength(1);
    expect(new Set(swapBodies).size).toBe(1);
  }, 60_000);
});
