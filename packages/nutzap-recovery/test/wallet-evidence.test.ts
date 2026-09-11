import { expect, it } from 'vitest';
import { verifyWalletPayloads } from '../src/wallet-evidence.js';

const expected = {
  mint: 'http://127.0.0.1:3338',
  amount: 15,
  outputs: [{ id: '001234567890abcd', secret: 'output', amount: 15 }],
};
const token = { mint: expected.mint, unit: 'sat', proofs: expected.outputs, del: [] };
const history = [
  ['direction', 'in'],
  ['amount', '15'],
  ['unit', 'sat'],
  ['e', 'token-event', '', 'created'],
];

it('accepts a conserved token with matching incoming history', () => {
  expect(verifyWalletPayloads(token, history, expected)).toBe(true);
});
it.each([
  ['amount', '999'],
  ['direction', 'out'],
  ['unit', 'usd'],
])('rejects wrong history %s even when event references are correct', (tag, value) => {
  expect(
    verifyWalletPayloads(
      token,
      history.map((t) => (t[0] === tag ? [tag, value] : t)),
      expected,
    ),
  ).toBe(false);
});
it('rejects ambiguous or missing history fields', () => {
  expect(verifyWalletPayloads(token, [...history, ['amount', '15']], expected)).toBe(false);
  expect(
    verifyWalletPayloads(
      token,
      history.filter((t) => t[0] !== 'direction'),
      expected,
    ),
  ).toBe(false);
  expect(verifyWalletPayloads(token, null, expected)).toBe(false);
});
it.each([
  { ...token, mint: 'http://127.0.0.1:9999' },
  { ...token, unit: 'usd' },
  { ...token, proofs: [{ ...expected.outputs[0], secret: 'unrelated' }] },
  { ...token, proofs: [{ ...expected.outputs[0], amount: 999 }] },
  { ...token, proofs: [...expected.outputs, ...expected.outputs] },
  { ...token, del: ['unrelated-token'] },
  null,
])('rejects token payload outside the exact saved output plan: %j', (bad) => {
  expect(verifyWalletPayloads(bad, history, expected)).toBe(false);
});
