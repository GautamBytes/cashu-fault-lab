import { describe, expect, it } from 'vitest';
import {
  computePayloadHash,
  computeProofSetHash,
  parseProtocolId,
  type CashuProof,
} from '../src/index';

const requestId = parseProtocolId('AAECAwQFBgcICQoLDA0ODw');
const proofA: CashuProof = { amount: 1, id: '00aa', secret: 'secret-a', C: '02aa' };
const proofB: CashuProof = { C: '02bb', secret: 'secret-b', id: '00bb', amount: 2 };

describe('delivery fingerprints', () => {
  it('produces the same payload hash for equivalent proof map key order', () => {
    const first = computePayloadHash({
      requestId,
      memo: null,
      mint: 'HTTPS://Mint.Example:443/',
      unit: 'sat',
      proofs: [proofA, proofB],
      createdAt: 100,
      expiresAt: 200,
    });
    const second = computePayloadHash({
      requestId,
      memo: null,
      mint: 'https://mint.example',
      unit: 'sat',
      proofs: [proofA, { amount: 2, id: '00bb', secret: 'secret-b', C: '02bb' }],
      createdAt: 100,
      expiresAt: 200,
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('binds payload hash to proof order', () => {
    const common = {
      requestId,
      memo: null,
      mint: 'https://mint.example',
      unit: 'sat',
      createdAt: 100,
      expiresAt: 200,
    } as const;

    expect(computePayloadHash({ ...common, proofs: [proofA, proofB] })).not.toBe(
      computePayloadHash({ ...common, proofs: [proofB, proofA] }),
    );
  });

  it('makes proof-set hash independent of Y ordering', () => {
    const y1 = Uint8Array.from([2, ...new Array<number>(32).fill(1)]);
    const y2 = Uint8Array.from([3, ...new Array<number>(32).fill(2)]);

    expect(computeProofSetHash({ mint: 'https://mint.example', unit: 'sat', ys: [y1, y2] })).toBe(
      computeProofSetHash({ mint: 'https://mint.example/', unit: 'sat', ys: [y2, y1] }),
    );
  });

  it('rejects a proof Y that is not a compressed 33-byte point', () => {
    expect(() =>
      computeProofSetHash({
        mint: 'https://mint.example',
        unit: 'sat',
        ys: [new Uint8Array(32)],
      }),
    ).toThrowError(/33-byte/i);

    expect(() =>
      computeProofSetHash({
        mint: 'https://mint.example',
        unit: 'sat',
        ys: [Uint8Array.from([4, ...new Array<number>(32).fill(1)])],
      }),
    ).toThrowError(/compressed/i);
  });
});
