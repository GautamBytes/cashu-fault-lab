import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { loopbackMint, validateNutzap } from '../src/protocol.js';

const key = (n: number) => Uint8Array.from([...Array(31).fill(0), n]);
const recipient = getPublicKey(key(1));
const lockingKey = getPublicKey(key(2));
const mint = 'http://127.0.0.1:3338';
const proof = {
  id: '00ad268c4d1f5826',
  amount: 16,
  C: `02${recipient}`,
  secret: JSON.stringify(['P2PK', { nonce: 'test', data: `02${lockingKey}` }]),
  dleq: { e: '01'.repeat(32), s: '02'.repeat(32), r: '03'.repeat(32) },
};
const info = finalizeEvent(
  {
    kind: 10019,
    created_at: 100,
    content: '',
    tags: [
      ['mint', mint, 'sat'],
      ['pubkey', lockingKey],
      ['relay', 'ws://127.0.0.1:4000'],
    ],
  },
  key(1),
);
function event(
  tags = [
    ['p', recipient],
    ['u', mint],
    ['unit', 'sat'],
    ['proof', JSON.stringify(proof)],
  ],
) {
  return finalizeEvent({ kind: 9321, created_at: 101, content: '', tags }, key(3));
}
describe('NIP-61 incoming payment boundary', () => {
  it('accepts a signed sender event using the separate advertised P2PK key', () => {
    expect(validateNutzap(event(), info).amount).toBe(16);
  });
  it('rejects tampered signatures, unadvertised mints, wrong recipient, and non-sat units', () => {
    expect(() => validateNutzap({ ...event(), content: 'tampered' }, info)).toThrow();
    for (const [tag, value] of [
      ['u', 'http://127.0.0.1:9999'],
      ['p', getPublicKey(key(4))],
      ['unit', 'usd'],
    ]) {
      expect(() =>
        validateNutzap(event(event().tags.map((t) => (t[0] === tag ? [tag!, value!] : t))), info),
      ).toThrow();
    }
  });
  it('rejects wrong P2PK keys, extra spending conditions, missing DLEQ and duplicate proofs', () => {
    const variants = [
      { ...proof, secret: JSON.stringify(['P2PK', { nonce: 'test', data: `02${recipient}` }]) },
      {
        ...proof,
        secret: JSON.stringify([
          'P2PK',
          {
            nonce: 'test',
            data: `02${lockingKey}`,
            tags: [
              ['locktime', '1'],
              ['refund', `02${recipient}`],
            ],
          },
        ]),
      },
      { ...proof, dleq: undefined },
    ];
    for (const p of variants)
      expect(() =>
        validateNutzap(
          event([
            ['p', recipient],
            ['u', mint],
            ['proof', JSON.stringify(p)],
          ]),
          info,
        ),
      ).toThrow();
    expect(() =>
      validateNutzap(event([...event().tags, ['proof', JSON.stringify(proof)]]), info),
    ).toThrow();
  });
  it('uses economic proof identity independently of event id and tag order', () => {
    const one = validateNutzap(event(), info);
    const two = validateNutzap(event([...event().tags].reverse()), info);
    expect(one.id).toBe(two.id);
  });
  it('enforces the event budget in UTF-8 bytes, not character count', () => {
    const large = finalizeEvent(
      { kind: 9321, created_at: 101, content: '界'.repeat(90_000), tags: event().tags },
      key(3),
    );
    expect(() => validateNutzap(large, info)).toThrow();
  });
  it('rejects non-string curve points rather than coercing arrays to strings', () => {
    expect(() =>
      validateNutzap(
        event(
          event().tags.map((t) =>
            t[0] === 'proof' ? ['proof', JSON.stringify({ ...proof, C: [proof.C] })] : t,
          ),
        ),
        info,
      ),
    ).toThrow();
  });
  it.each([
    'https://127.0.0.1:3338',
    'http://localhost:3338',
    'http://127.0.0.1.evil.test',
    'http://user:pass@127.0.0.1',
    'http://[::1]',
    'http://127.0.0.1/a',
    'http://127.0.0.1/?secret=1',
  ])('rejects mint URL outside the disposable profile: %s', (url) => {
    expect(() => loopbackMint(url)).toThrow();
  });
});
