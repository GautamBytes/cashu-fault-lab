import { describe, expect, it } from 'vitest';
import { assertExactRequestedAmount, computeInputFee, computeNetAmount } from '../src/index';

describe('NUT-02 input fees and exact amount', () => {
  it('rounds the sum of per-input ppk fees up once', () => {
    const proofs = [
      { amount: 4, id: 'keyset-a' },
      { amount: 4, id: 'keyset-a' },
      { amount: 4, id: 'keyset-a' },
    ];
    const fees = new Map([['keyset-a', 100]]);

    expect(computeInputFee(proofs, fees)).toBe(1);
    expect(computeNetAmount(proofs, fees)).toBe(11);
  });

  it('sums mixed-keyset fees before integer rounding', () => {
    const proofs = [
      { amount: 8, id: 'keyset-a' },
      { amount: 8, id: 'keyset-b' },
    ];
    expect(
      computeInputFee(
        proofs,
        new Map([
          ['keyset-a', 400],
          ['keyset-b', 600],
        ]),
      ),
    ).toBe(1);
  });

  it('rounds safely without overflowing the numerator', () => {
    expect(
      computeInputFee(
        [{ amount: 1, id: 'keyset-a' }],
        new Map([['keyset-a', 9_007_199_254_740_000]]),
      ),
    ).toBe(9_007_199_254_740);
  });

  it('requires a known nonnegative fee for every proof keyset', () => {
    expect(() => computeInputFee([{ amount: 1, id: 'missing' }], new Map())).toThrowError(
      /keyset/i,
    );
    expect(() =>
      computeInputFee([{ amount: 1, id: 'keyset-a' }], new Map([['keyset-a', -1]])),
    ).toThrowError(/fee/i);
  });

  it('rejects non-integer and overflowing amounts or fees', () => {
    expect(() =>
      computeNetAmount([{ amount: 1.5, id: 'keyset-a' }], new Map([['keyset-a', 0]])),
    ).toThrowError(/amount/i);
    expect(() =>
      computeInputFee([{ amount: 1, id: 'keyset-a' }], new Map([['keyset-a', 0.5]])),
    ).toThrowError(/fee/i);
    expect(() =>
      computeNetAmount(
        [
          { amount: Number.MAX_SAFE_INTEGER, id: 'keyset-a' },
          { amount: 1, id: 'keyset-a' },
        ],
        new Map([['keyset-a', 0]]),
      ),
    ).toThrowError(/safe integer/i);
  });

  it('requires exact requested net amount', () => {
    expect(() => assertExactRequestedAmount(11, 11)).not.toThrow();
    expect(() => assertExactRequestedAmount(12, 11)).toThrowError(/exact/i);
    expect(() => assertExactRequestedAmount(10, 11)).toThrowError(/exact/i);
  });
});
