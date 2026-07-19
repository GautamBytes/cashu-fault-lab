# Cashu Fault Lab Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone monorepo foundation and a fully tested, transport-independent `delivery-core` package for delivery IDs, mint normalization, monotonic receipts, and deterministic fingerprints.

**Architecture:** The first slice contains no wallet, mint, network, or database code. `delivery-core` is a pure TypeScript package whose behavior is fixed by tests; later sender, receiver, adapter, and oracle packages consume it through exported functions while the independent oracle reimplements the rules without importing this package.

**Tech Stack:** Node.js 24 LTS, pnpm 11.15.0, TypeScript 7.0.2, Vitest 4.1.10, cborg 5.1.7, Turborepo 2.10.5, Prettier 3.9.5.

## Global Constraints

- The repository is standalone and must not be embedded in cashu-ts, CDK, or Nutshell.
- The project package namespace is `@cashu-fault-lab/*`.
- `delivery-core` contains no HTTP, Nostr, database, wallet, mint client, or merchant-ledger code.
- Protocol IDs are exactly 16 cryptographically random bytes encoded as unpadded base64url.
- Mint URLs require HTTPS except explicit loopback endpoints and never accept credentials, query strings, or fragments.
- Receipt states are only `processing`, `settled`, and `rejected`; terminal states never regress.
- Fingerprints use SHA-256 over RFC 8949 deterministic CBOR with explicit domain separation.
- Tests must not log or snapshot Cashu proof secrets.
- Runtime dependencies are pinned to exact versions.

## File Structure

```text
package.json                         Root scripts, engines, and pinned tooling
pnpm-workspace.yaml                  Workspace package discovery
turbo.json                           Test and typecheck task graph
tsconfig.base.json                   Strict shared TypeScript settings
.prettierrc.json                     Repository formatting rules
.gitignore                           Generated and secret-bearing paths
packages/delivery-core/package.json  Pure package metadata and cborg dependency
packages/delivery-core/tsconfig.json Package compiler settings
packages/delivery-core/src/errors.ts Stable validation error codes
packages/delivery-core/src/ids.ts    Protocol ID generation and parsing
packages/delivery-core/src/mint-url.ts Mint URL policy and normalization
packages/delivery-core/src/receipt.ts Receipt model and monotonic transitions
packages/delivery-core/src/fingerprint.ts Deterministic payload/proof-set hashes
packages/delivery-core/src/index.ts  Deliberate public exports only
packages/delivery-core/test/*.test.ts Focused behavior tests
```

---

### Task 1: Monorepo and Protocol IDs

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.prettierrc.json`
- Create: `.gitignore`
- Create: `packages/delivery-core/package.json`
- Create: `packages/delivery-core/tsconfig.json`
- Create: `packages/delivery-core/test/ids.test.ts`
- Create: `packages/delivery-core/src/errors.ts`
- Create: `packages/delivery-core/src/ids.ts`
- Create: `packages/delivery-core/src/index.ts`

**Interfaces:**

- Consumes: Node.js `crypto.randomBytes` and `Buffer` base64url support.
- Produces: `DeliveryValidationError`, `DeliveryErrorCode`, `ProtocolId`, `generateProtocolId()`, and `parseProtocolId()`.

- [x] **Step 1: Create the monorepo manifests**

`package.json`:

```json
{
  "name": "cashu-fault-lab",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.15.0",
  "engines": {
    "node": ">=24.0.0 <25"
  },
  "scripts": {
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@types/node": "26.1.1",
    "prettier": "3.9.5",
    "turbo": "2.10.5",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - apps/*
  - adapters/*
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "test": {
      "outputs": ["coverage/**"]
    },
    "typecheck": {
      "outputs": []
    }
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2024"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`.prettierrc.json`:

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

`.gitignore`:

```gitignore
node_modules/
.turbo/
coverage/
artifacts/
.env
.env.*
!.env.example
*.log
```

`packages/delivery-core/package.json`:

```json
{
  "name": "@cashu-fault-lab/delivery-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --project tsconfig.json"
  },
  "dependencies": {
    "cborg": "5.1.7"
  }
}
```

`packages/delivery-core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 2: Install the pinned dependencies**

Run: `pnpm install --frozen-lockfile=false`

Expected: exit 0 and a new `pnpm-lock.yaml` containing exact resolved versions.

- [x] **Step 3: Write the failing protocol-ID test**

`packages/delivery-core/test/ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DeliveryValidationError, generateProtocolId, parseProtocolId } from '../src/index';

describe('protocol IDs', () => {
  it('encodes exactly 16 supplied bytes as canonical unpadded base64url', () => {
    const id = generateProtocolId(() => Uint8Array.from({ length: 16 }, (_, index) => index));

    expect(id).toBe('AAECAwQFBgcICQoLDA0ODw');
    expect(parseProtocolId(id)).toBe(id);
  });

  it.each(['', 'AAECAwQFBgcICQoLDA0ODw==', 'AAECAwQFBgcICQoLDA0OD', 'not+base64url/value____'])(
    'rejects a non-canonical or wrong-length ID: %s',
    (value) => {
      expect(() => parseProtocolId(value)).toThrowError(
        new DeliveryValidationError('INVALID_PROTOCOL_ID', 'Protocol ID must encode 16 bytes'),
      );
    },
  );

  it('rejects a random source that returns the wrong byte count', () => {
    expect(() => generateProtocolId(() => new Uint8Array(15))).toThrowError(
      new DeliveryValidationError('INVALID_RANDOM_SOURCE', 'Random source must return 16 bytes'),
    );
  });
});
```

- [x] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- ids.test.ts`

Expected: FAIL because `../src/index` does not exist.

- [x] **Step 5: Implement stable errors and protocol IDs**

`packages/delivery-core/src/errors.ts`:

```ts
export type DeliveryErrorCode =
  | 'INVALID_PROTOCOL_ID'
  | 'INVALID_RANDOM_SOURCE'
  | 'INVALID_MINT_URL'
  | 'INSECURE_MINT_URL'
  | 'INVALID_RECEIPT'
  | 'RECEIPT_IDENTITY_MISMATCH'
  | 'STATUS_REGRESSION'
  | 'STATUS_VERSION_CONFLICT'
  | 'INVALID_PROOF_POINT';

export class DeliveryValidationError extends Error {
  readonly code: DeliveryErrorCode;

  constructor(code: DeliveryErrorCode, message: string) {
    super(message);
    this.name = 'DeliveryValidationError';
    this.code = code;
  }
}
```

`packages/delivery-core/src/ids.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { DeliveryValidationError } from './errors';

export type ProtocolId = string & { readonly ProtocolId: unique symbol };
export type RandomBytes = (size: number) => Uint8Array;

const PROTOCOL_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function parseProtocolId(value: string): ProtocolId {
  if (!PROTOCOL_ID_PATTERN.test(value)) {
    throw new DeliveryValidationError('INVALID_PROTOCOL_ID', 'Protocol ID must encode 16 bytes');
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 16 || decoded.toString('base64url') !== value) {
    throw new DeliveryValidationError('INVALID_PROTOCOL_ID', 'Protocol ID must encode 16 bytes');
  }

  return value as ProtocolId;
}

export function generateProtocolId(source: RandomBytes = (size) => randomBytes(size)): ProtocolId {
  const bytes = source(16);
  if (bytes.length !== 16) {
    throw new DeliveryValidationError(
      'INVALID_RANDOM_SOURCE',
      'Random source must return 16 bytes',
    );
  }

  return parseProtocolId(Buffer.from(bytes).toString('base64url'));
}
```

`packages/delivery-core/src/index.ts`:

```ts
export { DeliveryValidationError, type DeliveryErrorCode } from './errors';
export { generateProtocolId, parseProtocolId, type ProtocolId, type RandomBytes } from './ids';
```

- [x] **Step 6: Run tests and type checking**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- ids.test.ts`

Expected: PASS with 3 tests.

Run: `pnpm --filter @cashu-fault-lab/delivery-core typecheck`

Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 7: Commit the protocol-ID foundation**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json .prettierrc.json .gitignore packages/delivery-core
git commit -m "feat: establish delivery core protocol IDs"
```

### Task 2: Mint URL Policy

**Files:**

- Create: `packages/delivery-core/test/mint-url.test.ts`
- Create: `packages/delivery-core/src/mint-url.ts`
- Modify: `packages/delivery-core/src/index.ts`

**Interfaces:**

- Consumes: `DeliveryValidationError` from Task 1.
- Produces: `normalizeMintUrl(value: string): string`.

- [x] **Step 1: Write the failing mint URL test**

`packages/delivery-core/test/mint-url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DeliveryValidationError, normalizeMintUrl } from '../src/index';

describe('normalizeMintUrl', () => {
  it.each([
    ['HTTPS://Mint.Example:443/', 'https://mint.example'],
    ['https://Mint.Example/cashu/', 'https://mint.example/cashu'],
    ['http://localhost:3338/', 'http://localhost:3338'],
    ['http://127.0.0.1:3338/', 'http://127.0.0.1:3338'],
    ['http://[::1]:3338/', 'http://[::1]:3338'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeMintUrl(input)).toBe(expected);
  });

  it.each([
    ['http://mint.example', 'INSECURE_MINT_URL'],
    ['ftp://mint.example', 'INVALID_MINT_URL'],
    ['https://user:password@mint.example', 'INVALID_MINT_URL'],
    ['https://mint.example?tenant=one', 'INVALID_MINT_URL'],
    ['https://mint.example/#fragment', 'INVALID_MINT_URL'],
    ['not a URL', 'INVALID_MINT_URL'],
  ] as const)('rejects an unsafe mint URL: %s', (input, expectedCode) => {
    try {
      normalizeMintUrl(input);
      throw new Error('expected normalizeMintUrl to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(DeliveryValidationError);
      expect((error as DeliveryValidationError).code).toBe(expectedCode);
    }
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- mint-url.test.ts`

Expected: FAIL because `normalizeMintUrl` is not exported.

- [x] **Step 3: Implement mint URL normalization**

`packages/delivery-core/src/mint-url.ts`:

```ts
import { DeliveryValidationError } from './errors';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeMintUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DeliveryValidationError('INVALID_MINT_URL', 'Mint URL is invalid');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DeliveryValidationError('INVALID_MINT_URL', 'Mint URL must use HTTP or HTTPS');
  }

  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new DeliveryValidationError('INSECURE_MINT_URL', 'Non-loopback mint URL must use HTTPS');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new DeliveryValidationError(
      'INVALID_MINT_URL',
      'Mint URL cannot contain credentials, query, or fragment',
    );
  }

  url.hostname = url.hostname.toLowerCase();
  const pathname =
    url.pathname === '/'
      ? ''
      : url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname;

  return `${url.protocol}//${url.host}${pathname}`;
}
```

Append to `packages/delivery-core/src/index.ts`:

```ts
export { normalizeMintUrl } from './mint-url';
```

- [x] **Step 4: Run tests and type checking**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- mint-url.test.ts`

Expected: PASS with 11 cases.

Run: `pnpm --filter @cashu-fault-lab/delivery-core typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit mint URL policy**

```bash
git add packages/delivery-core/src/mint-url.ts packages/delivery-core/src/index.ts packages/delivery-core/test/mint-url.test.ts
git commit -m "feat: define safe mint URL normalization"
```

### Task 3: Monotonic Delivery Receipts

**Files:**

- Create: `packages/delivery-core/test/receipt.test.ts`
- Create: `packages/delivery-core/src/receipt.ts`
- Modify: `packages/delivery-core/src/index.ts`

**Interfaces:**

- Consumes: `ProtocolId`, `parseProtocolId()`, and `DeliveryValidationError`.
- Produces: `DeliveryStatus`, `ReceiptDetailCode`, `DeliveryReceipt`, and `assertReceiptTransition()`.

- [x] **Step 1: Write the failing receipt transition test**

`packages/delivery-core/test/receipt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertReceiptTransition, parseProtocolId, type DeliveryReceipt } from '../src/index';

const requestId = parseProtocolId('AAECAwQFBgcICQoLDA0ODw');
const deliveryId = parseProtocolId('EBESExQVFhcYGRobHB0eHw');

function receipt(overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return {
    profile: 'cashu-delivery-v1',
    requestId,
    deliveryId,
    payloadHash: 'a'.repeat(64),
    status: 'processing',
    statusVersion: 1,
    mint: 'https://mint.example',
    unit: 'sat',
    amount: 100,
    detailCode: 'redeeming',
    ...overrides,
  };
}

describe('assertReceiptTransition', () => {
  it('accepts an initial processing receipt and a later settled receipt', () => {
    const processing = receipt();
    const settled = receipt({ status: 'settled', statusVersion: 2, detailCode: 'settled' });

    expect(() => assertReceiptTransition(undefined, processing)).not.toThrow();
    expect(() => assertReceiptTransition(processing, settled)).not.toThrow();
  });

  it('accepts an exact duplicate without incrementing the status version', () => {
    const processing = receipt();
    expect(() => assertReceiptTransition(processing, { ...processing })).not.toThrow();
  });

  it('rejects a stale receipt after settlement', () => {
    const settled = receipt({ status: 'settled', statusVersion: 2, detailCode: 'settled' });
    expect(() => assertReceiptTransition(settled, receipt())).toThrowError(/regress/i);
  });

  it('rejects different content at the same status version', () => {
    expect(() =>
      assertReceiptTransition(receipt(), receipt({ detailCode: 'recovery_blocked' })),
    ).toThrowError(/same version/i);
  });

  it('rejects a changed request, delivery, or payload identity', () => {
    expect(() =>
      assertReceiptTransition(
        receipt(),
        receipt({ payloadHash: 'b'.repeat(64), statusVersion: 2 }),
      ),
    ).toThrowError(/identity/i);
  });

  it.each([
    receipt({ statusVersion: 0 }),
    receipt({ mint: 'HTTPS://Mint.Example/' }),
    receipt({ status: 'settled', detailCode: 'redeeming' }),
    receipt({ status: 'processing', detailCode: 'settled' }),
  ])('rejects an invalid receipt', (invalidReceipt) => {
    expect(() => assertReceiptTransition(undefined, invalidReceipt)).toThrowError(/invalid/i);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- receipt.test.ts`

Expected: FAIL because `assertReceiptTransition` is not exported.

- [x] **Step 3: Implement receipt validation and monotonic transitions**

`packages/delivery-core/src/receipt.ts`:

```ts
import { DeliveryValidationError } from './errors';
import { parseProtocolId, type ProtocolId } from './ids';
import { normalizeMintUrl } from './mint-url';

export type DeliveryStatus = 'processing' | 'settled' | 'rejected';
export type ReceiptDetailCode =
  'accepted' | 'redeeming' | 'recovery_blocked' | 'settled' | 'invalid' | 'expired' | 'conflict';

export interface DeliveryReceipt {
  readonly profile: 'cashu-delivery-v1';
  readonly requestId: ProtocolId;
  readonly deliveryId: ProtocolId;
  readonly payloadHash: string;
  readonly status: DeliveryStatus;
  readonly statusVersion: number;
  readonly mint: string;
  readonly unit: string;
  readonly amount: number;
  readonly detailCode: ReceiptDetailCode;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const STATUS_DETAILS: Readonly<Record<DeliveryStatus, ReadonlySet<ReceiptDetailCode>>> = {
  processing: new Set(['accepted', 'redeeming', 'recovery_blocked']),
  settled: new Set(['settled']),
  rejected: new Set(['invalid', 'expired', 'conflict']),
};

function assertValidReceipt(receipt: DeliveryReceipt): void {
  parseProtocolId(receipt.requestId);
  parseProtocolId(receipt.deliveryId);
  if (
    receipt.profile !== 'cashu-delivery-v1' ||
    !HASH_PATTERN.test(receipt.payloadHash) ||
    !Number.isSafeInteger(receipt.statusVersion) ||
    receipt.statusVersion < 1 ||
    !Number.isSafeInteger(receipt.amount) ||
    receipt.amount < 0 ||
    receipt.unit.length === 0 ||
    receipt.mint.length === 0 ||
    normalizeMintUrl(receipt.mint) !== receipt.mint ||
    !STATUS_DETAILS[receipt.status]?.has(receipt.detailCode)
  ) {
    throw new DeliveryValidationError('INVALID_RECEIPT', 'Delivery receipt is invalid');
  }
}

function sameIdentity(previous: DeliveryReceipt, next: DeliveryReceipt): boolean {
  return (
    previous.profile === next.profile &&
    previous.requestId === next.requestId &&
    previous.deliveryId === next.deliveryId &&
    previous.payloadHash === next.payloadHash &&
    previous.mint === next.mint &&
    previous.unit === next.unit &&
    previous.amount === next.amount
  );
}

function sameReceipt(previous: DeliveryReceipt, next: DeliveryReceipt): boolean {
  return (
    sameIdentity(previous, next) &&
    previous.status === next.status &&
    previous.statusVersion === next.statusVersion &&
    previous.detailCode === next.detailCode
  );
}

export function assertReceiptTransition(
  previous: DeliveryReceipt | undefined,
  next: DeliveryReceipt,
): void {
  assertValidReceipt(next);
  if (!previous) return;

  assertValidReceipt(previous);
  if (!sameIdentity(previous, next)) {
    throw new DeliveryValidationError(
      'RECEIPT_IDENTITY_MISMATCH',
      'Receipt identity cannot change',
    );
  }

  if (sameReceipt(previous, next)) return;

  if (next.statusVersion === previous.statusVersion) {
    throw new DeliveryValidationError(
      'STATUS_VERSION_CONFLICT',
      'Different receipt content cannot use the same version',
    );
  }

  if (
    next.statusVersion < previous.statusVersion ||
    previous.status === 'settled' ||
    previous.status === 'rejected'
  ) {
    throw new DeliveryValidationError('STATUS_REGRESSION', 'Receipt status cannot regress');
  }
}
```

Append to `packages/delivery-core/src/index.ts`:

```ts
export {
  assertReceiptTransition,
  type DeliveryReceipt,
  type DeliveryStatus,
  type ReceiptDetailCode,
} from './receipt';
```

- [x] **Step 4: Run receipt tests, full package tests, and type checking**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- receipt.test.ts`

Expected: PASS with 5 tests.

Run: `pnpm --filter @cashu-fault-lab/delivery-core test`

Expected: all Task 1–3 tests pass.

Run: `pnpm --filter @cashu-fault-lab/delivery-core typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit monotonic receipts**

```bash
git add packages/delivery-core/src/receipt.ts packages/delivery-core/src/index.ts packages/delivery-core/test/receipt.test.ts
git commit -m "feat: enforce monotonic delivery receipts"
```

### Task 4: Deterministic Delivery Fingerprints

**Files:**

- Create: `packages/delivery-core/test/fingerprint.test.ts`
- Create: `packages/delivery-core/src/fingerprint.ts`
- Modify: `packages/delivery-core/src/index.ts`

**Interfaces:**

- Consumes: `ProtocolId`, `normalizeMintUrl()`, Node.js SHA-256, and `cborg` RFC 8949 encoding.
- Produces: `CashuProof`, `PayloadFingerprintInput`, `ProofSetFingerprintInput`, `computePayloadHash()`, and `computeProofSetHash()`.

- [x] **Step 1: Write the failing fingerprint tests**

`packages/delivery-core/test/fingerprint.test.ts`:

```ts
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
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- fingerprint.test.ts`

Expected: FAIL because the fingerprint functions are not exported.

- [x] **Step 3: Implement RFC 8949 deterministic hashes**

`packages/delivery-core/src/fingerprint.ts`:

```ts
import { createHash } from 'node:crypto';
import { encode, rfc8949EncodeOptions } from 'cborg';
import { DeliveryValidationError } from './errors';
import type { ProtocolId } from './ids';
import { normalizeMintUrl } from './mint-url';

export interface CashuProof {
  readonly amount: number | bigint;
  readonly id: string;
  readonly secret: string;
  readonly C: string;
  readonly witness?: string;
  readonly dleq?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface PayloadFingerprintInput {
  readonly requestId: ProtocolId;
  readonly memo: string | null;
  readonly mint: string;
  readonly unit: string;
  readonly proofs: readonly CashuProof[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ProofSetFingerprintInput {
  readonly mint: string;
  readonly unit: string;
  readonly ys: readonly Uint8Array[];
}

function sha256Hex(value: unknown): string {
  const encoded = encode(value, rfc8949EncodeOptions);
  return createHash('sha256').update(encoded).digest('hex');
}

export function computePayloadHash(input: PayloadFingerprintInput): string {
  return sha256Hex([
    'cashu-delivery-v1/payload',
    input.requestId,
    input.memo,
    normalizeMintUrl(input.mint),
    input.unit,
    input.proofs,
    1,
    input.createdAt,
    input.expiresAt,
  ]);
}

export function computeProofSetHash(input: ProofSetFingerprintInput): string {
  const ys = input.ys.map((value) => {
    if (value.length !== 33 || (value[0] !== 2 && value[0] !== 3)) {
      throw new DeliveryValidationError(
        'INVALID_PROOF_POINT',
        'Proof Y must be a compressed 33-byte point with prefix 02 or 03',
      );
    }
    return Uint8Array.from(value);
  });
  ys.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  return sha256Hex(['cashu-delivery-v1/proof-set', normalizeMintUrl(input.mint), input.unit, ys]);
}
```

Append to `packages/delivery-core/src/index.ts`:

```ts
export {
  computePayloadHash,
  computeProofSetHash,
  type CashuProof,
  type PayloadFingerprintInput,
  type ProofSetFingerprintInput,
} from './fingerprint';
```

- [x] **Step 4: Run the full foundation verification**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test`

Expected: all protocol-ID, mint URL, receipt, and fingerprint tests pass.

Run: `pnpm --filter @cashu-fault-lab/delivery-core typecheck`

Expected: exit 0 with no diagnostics.

Run: `pnpm format:check`

Expected: all tracked files conform to Prettier.

- [ ] **Step 5: Commit deterministic fingerprints**

```bash
git add packages/delivery-core/src/fingerprint.ts packages/delivery-core/src/index.ts packages/delivery-core/test/fingerprint.test.ts
git commit -m "feat: add deterministic delivery fingerprints"
```

## Foundation Completion Gate

The slice is complete only when:

- `pnpm --filter @cashu-fault-lab/delivery-core test` passes every test.
- `pnpm --filter @cashu-fault-lab/delivery-core typecheck` exits 0.
- `pnpm format:check` exits 0.
- The public package exports only the interfaces named in Tasks 1–4.
- No source file imports cashu-ts, CDK, Nostr, HTTP, database, or merchant-ledger code.
- The next implementation plan can consume `delivery-core` to build JSON Schemas, executable vectors, and the adapter contract without changing these semantics.
