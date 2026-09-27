import { bech32, bech32m } from '@scure/base';

export const PAYMENT_REQUEST_PROFILE = 'nut26-bech32m-v1';
export const PAYMENT_REQUEST_SPEC = {
  repository: 'https://github.com/cashubtc/nuts',
  ref: '8bde3c0c3684430d852ab543ac8ca72913770dc0',
  path: '26.md',
  sha256: 'd66e85a7404aa4e562784675d9520b64315824f6d12bae36ec94a41ab6d18c89',
};

export interface RequestFields {
  i: string | null;
  a: string | null;
  u: string | null;
  s: boolean;
  m: string[];
  d: string | null;
  t: { t: string; a: string; relays: string[]; g: string[][] }[];
  nut10: { k: string; d: string; t: string[][] } | null;
  mp: boolean;
  sm: { mn: string; mf: string }[];
}
export type CodecId = 'cashu-ts' | 'cdk';
export interface PaymentRequestVector {
  id: string;
  encoded: string;
  reject: boolean;
  expected: RequestFields;
  gaps?: Partial<Record<CodecId, { code: string; observed: RequestFields; stages?: number[] }>>;
}

const fields = (overrides: Partial<RequestFields> = {}): RequestFields => ({
  i: null,
  a: null,
  u: null,
  s: false,
  m: [],
  d: null,
  t: [],
  nut10: null,
  mp: false,
  sm: [],
  ...overrides,
});
const bytes = (value: string) => Buffer.from(value, 'utf8');
const tlv = (tag: number, value: Uint8Array): Buffer => {
  if (value.length > 65535) throw Error('Fixture TLV exceeds u16');
  return Buffer.concat([Buffer.from([tag, value.length >> 8, value.length & 255]), value]);
};
const join = (...parts: Uint8Array[]) => Buffer.concat(parts);
const tuple = (...values: string[]) =>
  join(
    ...values.map((value) => {
      const data = bytes(value);
      if (data.length > 255) throw Error('Fixture tuple exceeds u8');
      return join(Buffer.from([data.length]), data);
    }),
  );
const u64 = (value: bigint) => {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(value);
  return result;
};
const encode = (data: Uint8Array) =>
  bech32m.encode('creqb', bech32m.toWords(data), false).toUpperCase();
const vector = (
  id: string,
  data: Uint8Array,
  expected: Partial<RequestFields> = {},
  reject = false,
): PaymentRequestVector => ({ id, encoded: encode(data), reject, expected: fields(expected) });

// Literal upstream example anchors the fixture encoder independently of either wallet SDK.
const example =
  'CREQB1QYQQWER9D4HNZV3NQGQQSQQQQQQQQQQRAQPSQQGQQSQQZQG9QQVXSAR5WPEN5TE0D45KUAPWV4UXZMTSD3JJUCM0D5RQQRJRDANXVET9YPCXZ7TDV4H8GXHR3TQ';
const exampleFields = fields({
  i: 'demo123',
  a: '1000',
  u: 'sat',
  s: true,
  m: ['https://mint.example.com'],
  d: 'Coffee payment',
});
const publicKey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const relays = ['wss://relay.example.com', 'wss://backup.example.com'];
const httpTarget = 'https://callback.example.com/pay';
const http = join(
  tlv(1, Buffer.from([1])),
  tlv(2, bytes(httpTarget)),
  tlv(3, tuple('priority', 'backup')),
);
const nostr = join(tlv(1, Buffer.from([0])), tlv(2, Buffer.from(publicKey, 'hex')));
const nostrTags = join(tlv(3, tuple('r', ...relays)), tlv(3, tuple('n', '17')));
const core = tlv(1, bytes('fixture'));
const coreFields = fields({ i: 'fixture' });
const unsupportedFields = {
  'cashu-ts': { code: 'CURRENT_FIELDS_DROPPED', observed: coreFields },
  cdk: { code: 'CURRENT_FIELDS_DROPPED', observed: coreFields },
};

export const paymentRequestVectors: PaymentRequestVector[] = [
  { id: 'upstream-uppercase', encoded: example, expected: exampleFields, reject: false },
  {
    id: 'upstream-lowercase',
    encoded: example.toLowerCase(),
    expected: exampleFields,
    reject: false,
  },
  vector('in-band', core, { i: 'fixture' }),
  vector('transport-priority-and-tags', join(tlv(7, join(nostr, nostrTags)), tlv(7, http)), {
    t: [
      { t: 'nostr', a: publicKey, relays, g: [['n', '17']] },
      { t: 'post', a: httpTarget, relays: [], g: [['priority', 'backup']] },
    ],
  }),
  vector('nostr-without-relays', tlv(7, nostr), {
    t: [{ t: 'nostr', a: publicKey, relays: [], g: [] }],
  }),
  vector(
    'custom-unit-utf8-multiple-mints',
    join(
      tlv(3, bytes('msat')),
      tlv(5, bytes('https://one.example.com')),
      tlv(5, bytes('https://two.example.com')),
      tlv(6, bytes('Coffee ☕')),
    ),
    { u: 'msat', m: ['https://one.example.com', 'https://two.example.com'], d: 'Coffee ☕' },
  ),
  vector('u64-max', tlv(2, u64(18446744073709551615n)), { a: '18446744073709551615' }),
  vector('zero-amount', tlv(2, u64(0n)), { a: '0' }),
  ...(['P2PK', 'HTLC'] as const).map((kind, index) =>
    vector(
      `nut10-${kind.toLowerCase()}`,
      tlv(
        8,
        join(
          tlv(1, Buffer.from([index])),
          tlv(2, bytes(publicKey)),
          tlv(3, tuple('locktime', '1700000000')),
        ),
      ),
      { nut10: { k: kind, d: publicKey, t: [['locktime', '1700000000']] } },
    ),
  ),
  vector('unknown-top-level-tag', join(core, tlv(250, Buffer.from([1, 2]))), { i: 'fixture' }),
  vector('unknown-transport-tag', tlv(7, join(nostr, tlv(250, Buffer.from([1, 2])))), {
    t: [{ t: 'nostr', a: publicKey, relays: [], g: [] }],
  }),
  {
    ...vector('mint-preferred', join(core, tlv(9, Buffer.from([1]))), { i: 'fixture', mp: true }),
    gaps: unsupportedFields,
  },
  {
    ...vector(
      'supported-methods',
      join(
        core,
        tlv(10, join(tlv(1, bytes('bolt11')), tlv(2, u64(18446744073709551615n)))),
        tlv(10, tlv(1, bytes('bolt12'))),
      ),
      {
        i: 'fixture',
        sm: [
          { mn: 'bolt11', mf: '18446744073709551615' },
          { mn: 'bolt12', mf: '0' },
        ],
      },
    ),
    gaps: unsupportedFields,
  },
  {
    id: 'checksum-corruption',
    encoded: `${example.slice(0, -1)}P`,
    expected: exampleFields,
    reject: true,
  },
  { id: 'mixed-case', encoded: `c${example.slice(1)}`, expected: exampleFields, reject: true },
  {
    id: 'wrong-hrp',
    encoded: bech32m.encode('wrong', bech32m.toWords(core), false),
    expected: coreFields,
    reject: true,
  },
  {
    id: 'bech32-not-bech32m',
    encoded: bech32.encode('creqb', bech32.toWords(core), false),
    expected: coreFields,
    reject: true,
  },
  vector('truncated-header-one-byte', join(core, Buffer.from([6])), { i: 'fixture' }, true),
  vector('truncated-header-two-bytes', join(core, Buffer.from([6, 0])), { i: 'fixture' }, true),
  vector('truncated-value', join(core, Buffer.from([6, 0, 2, 65])), {}, true),
  vector('amount-wrong-length', tlv(2, Buffer.alloc(7)), {}, true),
  vector(
    'nested-truncated-header',
    tlv(7, join(nostr, Buffer.from([3]))),
    { t: [{ t: 'nostr', a: publicKey, relays: [], g: [] }] },
    true,
  ),
  vector('nested-truncated-value', tlv(7, join(nostr, Buffer.from([3, 0, 2, 1]))), {}, true),
  vector('tuple-truncated-value', tlv(7, join(nostr, tlv(3, Buffer.from([4, 65])))), {}, true),
  vector(
    'nostr-key-wrong-length',
    tlv(7, join(tlv(1, Buffer.from([0])), tlv(2, Buffer.alloc(31)))),
    {},
    true,
  ),
];

// Exact, version-pinned SDK deviations. Other acceptance or field changes still fail.
for (const vector of paymentRequestVectors) {
  if (vector.id === 'mixed-case')
    vector.gaps = { 'cashu-ts': { code: 'MIXED_CASE_ACCEPTED', observed: vector.expected } };
  if (vector.id === 'bech32-not-bech32m')
    vector.gaps = { cdk: { code: 'BECH32_CHECKSUM_ACCEPTED', observed: vector.expected } };
  if (
    ['truncated-header-one-byte', 'truncated-header-two-bytes', 'nested-truncated-header'].includes(
      vector.id,
    )
  )
    vector.gaps = { cdk: { code: 'TRUNCATED_TLV_HEADER_ACCEPTED', observed: vector.expected } };
  if (vector.id === 'transport-priority-and-tags') {
    const observed = structuredClone(vector.expected);
    observed.t[0]!.relays = [...relays, ...relays];
    vector.gaps = {
      'cashu-ts': { code: 'CDK_REENCODING_DUPLICATES_RELAYS', observed, stages: [1, 2] },
      cdk: { code: 'CDK_REENCODING_DUPLICATES_RELAYS', observed, stages: [2] },
    };
  }
}
