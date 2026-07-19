import { createSecret, pointFromHex } from '@cashu/cashu-ts';
import type { ProtocolId } from '@cashu-fault-lab/delivery-core';
import { afterEach, describe, expect, it } from 'vitest';
import { CashuTsProofVerifier } from '../src/adapters/cashu-ts-proof-verifier.js';
import { MockMintServer, mockKeysetId } from './mock-mint.js';

const servers: MockMintServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

function deliveryPayload(mint: string, secret = 'input-secret') {
  return {
    id: 'AAECAwQFBgcICQoLDA0ODw' as ProtocolId,
    memo: null,
    mint,
    unit: 'sat',
    proofs: [
      {
        amount: 8,
        id: mockKeysetId,
        secret,
        C: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      },
    ],
    delivery: {
      version: 1 as const,
      id: 'EBESExQVFhcYGRobHB0eHw' as ProtocolId,
      createdAt: 1_784_399_400,
      expiresAt: 1_784_400_300,
    },
  };
}

describe('CashuTsProofVerifier', () => {
  it('derives Y, HMAC claims, proof-set hash, and exact net amount after fees', async () => {
    const mint = new MockMintServer({ nut09: true, nut19Ttl: null, inputFeePpk: 1_000 });
    servers.push(mint);
    await mint.start();
    const verifier = new CashuTsProofVerifier({ proofClaimKey: Buffer.alloc(32, 7) });

    const result = await verifier.inspect({ payload: deliveryPayload(mint.url) });

    expect(result.ys).toHaveLength(1);
    expect(() => pointFromHex(result.ys[0]!)).not.toThrow();
    expect(result.proofClaimIds[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(result.proofSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.netAmount).toBe(7);
  });

  it('rejects invalid DLEQ evidence when the proof includes it', async () => {
    const mint = new MockMintServer({ nut09: true, nut19Ttl: null });
    servers.push(mint);
    await mint.start();
    const verifier = new CashuTsProofVerifier({ proofClaimKey: Buffer.alloc(32, 7) });
    const payload = deliveryPayload(mint.url);

    await expect(
      verifier.inspect({
        payload: {
          ...payload,
          proofs: [{ ...payload.proofs[0]!, dleq: { e: '01', s: '02', r: '03' } }],
        },
      }),
    ).rejects.toThrowError(/DLEQ/i);
  });

  it('rejects a proof denomination missing from its keyset', async () => {
    const mint = new MockMintServer({ nut09: true, nut19Ttl: null });
    servers.push(mint);
    await mint.start();
    const verifier = new CashuTsProofVerifier({ proofClaimKey: Buffer.alloc(32, 7) });
    const payload = deliveryPayload(mint.url);

    await expect(
      verifier.inspect({
        payload: {
          ...payload,
          proofs: [{ ...payload.proofs[0]!, amount: 4 }],
        },
      }),
    ).rejects.toThrowError(/denomination/i);
  });

  it('rejects an unsigned NUT-10 P2PK proof', async () => {
    const mint = new MockMintServer({ nut09: true, nut19Ttl: null });
    servers.push(mint);
    await mint.start();
    const verifier = new CashuTsProofVerifier({ proofClaimKey: Buffer.alloc(32, 7) });
    const p2pkSecret = createSecret(
      'P2PK',
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    );

    await expect(
      verifier.inspect({ payload: deliveryPayload(mint.url, p2pkSecret) }),
    ).rejects.toThrowError(/spending condition|authorized/i);
  });
});
