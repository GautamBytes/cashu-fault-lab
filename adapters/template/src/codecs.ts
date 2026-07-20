import {
  computePayloadHash,
  computeProofSetHash,
  normalizeMintUrl,
  parseCompressedPoint,
  parseDeliveryPayloadJson,
  type CashuProof,
} from '@cashu-fault-lab/delivery-core';

export function validatePayloadBytes(payloadBytes: Uint8Array): {
  payloadHash: string;
  proofSetHash: string;
} {
  const payload = parseDeliveryPayloadJson(payloadBytes, Math.floor(Date.now() / 1000));

  const payloadHash = computePayloadHash({
    requestId: payload.id,
    memo: payload.memo,
    mint: payload.mint,
    unit: payload.unit,
    proofs: payload.proofs,
    createdAt: payload.delivery.createdAt,
    expiresAt: payload.delivery.expiresAt,
  });

  const proofYs = payload.proofs.map((proof) => parseCompressedPoint(hexToBytes(proof.C)));

  const proofSetHash = computeProofSetHash({
    mint: payload.mint,
    unit: payload.unit,
    ys: proofYs,
  });

  return { payloadHash, proofSetHash };
}

export function normalizeMint(mintUrl: string): string {
  return normalizeMintUrl(mintUrl);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export type { CashuProof };
