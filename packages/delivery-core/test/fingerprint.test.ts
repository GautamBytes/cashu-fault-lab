import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computePayloadHash,
  computeProofSetHash,
  encodePayloadFingerprint,
  encodeProofSetFingerprint,
  parseCompressedPoint,
  parseProtocolId,
  type CashuProof,
  type PayloadFingerprintInput,
} from '../src/index';

interface FingerprintVector {
  readonly payload: {
    readonly input: {
      readonly request_id: string;
      readonly memo: string | null;
      readonly mint: string;
      readonly unit: string;
      readonly proofs: readonly CashuProof[];
      readonly created_at: number;
      readonly expires_at: number;
    };
    readonly cbor_hex: string;
    readonly sha256: string;
  };
  readonly proof_set: {
    readonly input: {
      readonly mint: string;
      readonly unit: string;
      readonly ys: readonly string[];
    };
    readonly cbor_hex: string;
    readonly sha256: string;
  };
}

const vector = JSON.parse(
  readFileSync(
    new URL('../../../spec/vectors/delivery-v1-fingerprints.json', import.meta.url),
    'utf8',
  ),
) as FingerprintVector;

const requestId = parseProtocolId('AAECAwQFBgcICQoLDA0ODw');
const proofA: CashuProof = { amount: 1, id: '00aa', secret: 'secret-a', C: '02aa' };
const proofB: CashuProof = { C: '02bb', secret: 'secret-b', id: '00bb', amount: 2 };

function payloadInput(overrides: Partial<PayloadFingerprintInput> = {}): PayloadFingerprintInput {
  return {
    requestId,
    memo: null,
    mint: 'https://mint.example',
    unit: 'sat',
    proofs: [proofA, proofB],
    createdAt: 100,
    expiresAt: 200,
    ...overrides,
  };
}

describe('delivery fingerprints', () => {
  it('matches the checked-in canonical-CBOR and SHA-256 vectors', () => {
    const payload = {
      requestId: parseProtocolId(vector.payload.input.request_id),
      memo: vector.payload.input.memo,
      mint: vector.payload.input.mint,
      unit: vector.payload.input.unit,
      proofs: vector.payload.input.proofs,
      createdAt: vector.payload.input.created_at,
      expiresAt: vector.payload.input.expires_at,
    };
    const ys = vector.proof_set.input.ys.map((value) =>
      parseCompressedPoint(Uint8Array.from(Buffer.from(value, 'hex'))),
    );

    expect(Buffer.from(encodePayloadFingerprint(payload)).toString('hex')).toBe(
      vector.payload.cbor_hex,
    );
    expect(computePayloadHash(payload)).toBe(vector.payload.sha256);
    expect(
      Buffer.from(
        encodeProofSetFingerprint({
          mint: vector.proof_set.input.mint,
          unit: vector.proof_set.input.unit,
          ys,
        }),
      ).toString('hex'),
    ).toBe(vector.proof_set.cbor_hex);
    expect(
      computeProofSetHash({
        mint: vector.proof_set.input.mint,
        unit: vector.proof_set.input.unit,
        ys,
      }),
    ).toBe(vector.proof_set.sha256);
  });
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

  it.each([
    [
      'explicit undefined',
      payloadInput({
        proofs: [{ ...proofA, witness: undefined } as unknown as CashuProof],
      }),
    ],
    ['bigint', payloadInput({ proofs: [{ ...proofA, amount: 1n } as unknown as CashuProof] })],
    [
      'map',
      payloadInput({
        proofs: [{ ...proofA, extra: new Map([['key', 'value']]) } as unknown as CashuProof],
      }),
    ],
    [
      'typed array',
      payloadInput({
        proofs: [{ ...proofA, extra: Uint8Array.from([1, 2, 3]) } as unknown as CashuProof],
      }),
    ],
    ['fractional amount', payloadInput({ proofs: [{ ...proofA, amount: 1.5 }] })],
    ['non-finite timestamp', payloadInput({ createdAt: Number.NaN })],
  ])('rejects non-wire %s values before hashing', (_label, input) => {
    expect(() => computePayloadHash(input as PayloadFingerprintInput)).toThrowError(
      /JSON-compatible|safe integer/i,
    );
  });

  it.each([
    [
      'request ID',
      payloadInput({ requestId: 'not-a-protocol-id' as PayloadFingerprintInput['requestId'] }),
    ],
    ['unit', payloadInput({ unit: '' })],
    [
      'proof count',
      payloadInput({
        proofs: Array.from({ length: 257 }, (_, index) => ({
          ...proofA,
          secret: `secret-${index}`,
        })),
      }),
    ],
    ['timestamp order', payloadInput({ createdAt: 200, expiresAt: 200 })],
    ['validity window', payloadInput({ createdAt: 100, expiresAt: 86_501 })],
  ])('rejects an invalid %s before hashing', (_label, input) => {
    expect(() => computePayloadHash(input as PayloadFingerprintInput)).toThrowError();
  });

  it('rejects a sparse proof array before hashing', () => {
    expect(() =>
      computePayloadHash(
        payloadInput({ proofs: Array(1) as unknown as readonly CashuProof[] }),
      ),
    ).toThrowError(/holes/i);
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

  it.each([
    Uint8Array.from([2, ...new Array<number>(32).fill(0)]),
    Uint8Array.from([2, ...new Array<number>(32).fill(255)]),
  ])('rejects a compressed encoding that is not a secp256k1 point', (invalidPoint) => {
    expect(() =>
      computeProofSetHash({
        mint: 'https://mint.example',
        unit: 'sat',
        ys: [invalidPoint],
      }),
    ).toThrowError(/secp256k1/i);
  });

  it('rejects a duplicate Y within one proof set', () => {
    const y = Uint8Array.from([2, ...new Array<number>(32).fill(1)]);

    expect(() =>
      computeProofSetHash({
        mint: 'https://mint.example',
        unit: 'sat',
        ys: [y, Uint8Array.from(y)],
      }),
    ).toThrowError(/duplicate/i);
  });
});
