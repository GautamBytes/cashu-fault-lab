# Delivery Core Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `delivery-core` safe for untrusted wire data, deterministic across languages, consumable by native Node.js, and backed by exact vectors.

**Architecture:** Keep the package transport-independent and pure. Add explicit parsing/normalization boundaries before deterministic encoding, separate receiver mutation rules from sender observation merging, validate SEC1 points through Node/OpenSSL, and publish built ESM plus declarations from `dist`.

**Tech Stack:** Node.js 24 LTS, pnpm 11.15.0, TypeScript 7.0.2, Vitest 4.1.10, cborg 5.1.7, Turborepo 2.10.5, Prettier 3.9.5.

## Global Constraints

- No HTTP, Nostr, database, wallet, mint client, or merchant-ledger code enters `delivery-core`.
- All behavior changes follow red-green-refactor and retain stable `DeliveryValidationError` codes.
- Fingerprint input is restricted to JSON-compatible values and safe integers.
- Wire receipt keys are snake_case; internal TypeScript keys remain camelCase.
- Receiver mutations use exact version increments; sender observations may skip versions.
- Runtime dependencies remain pinned exactly.
- No bearer proof material is logged or snapshot.

---

### Task 1: Strict Mint URL Policy

**Files:**
- Modify: `packages/delivery-core/test/mint-url.test.ts`
- Modify: `packages/delivery-core/src/mint-url.ts`

**Interfaces:**
- Consumes: `DeliveryValidationError`.
- Produces: `normalizeMintUrl(value: string): string` with explicit raw-syntax rejection.

- [ ] **Step 1: Write failing raw-syntax tests**

Add cases that require `INVALID_MINT_URL` for `https://mint.example?`, `https://mint.example#`, `https://@mint.example`, leading/trailing whitespace, and backslashes. Add positive vectors for default-port removal, IDNA host normalization, and preserved non-root paths.

```ts
it.each([
  'https://mint.example?',
  'https://mint.example#',
  'https://@mint.example',
  ' https://mint.example',
  'https://mint.example\\cashu',
])('rejects ambiguous raw URL syntax: %s', (value) => {
  expect(() => normalizeMintUrl(value)).toThrowError(DeliveryValidationError);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- mint-url.test.ts`

Expected: FAIL because empty query/fragment/userinfo and parser-normalized whitespace/backslashes are accepted.

- [ ] **Step 3: Implement explicit pre-parse checks**

Before `new URL(value)`, reject `value !== value.trim()`, `value.includes('\\')`, `value.includes('?')`, and `value.includes('#')`. Extract the raw authority between `//` and the first `/`; reject `@` there. Retain the existing protocol, loopback, credential, normalization, and one-trailing-slash rules.

- [ ] **Step 4: Run focused and full package tests**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- mint-url.test.ts`

Expected: PASS.

Run: `pnpm --filter @cashu-fault-lab/delivery-core test`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/delivery-core/src/mint-url.ts packages/delivery-core/test/mint-url.test.ts
git commit -m "fix: reject ambiguous mint URL syntax"
```

### Task 2: Safe Receipt Codec and Split State Semantics

**Files:**
- Modify: `packages/delivery-core/test/receipt.test.ts`
- Modify: `packages/delivery-core/src/receipt.ts`
- Modify: `packages/delivery-core/src/index.ts`

**Interfaces:**
- Produces: `DeliveryReceiptWire`, `parseDeliveryReceipt(value: unknown)`, `serializeDeliveryReceipt(receipt)`, `assertReceiptTransition(previous, next)`, and `mergeObservedReceipt(previous, next)`.

- [ ] **Step 1: Write failing parser/codec tests**

Tests must prove that a snake_case wire receipt round-trips, `status: "toString"` yields `DeliveryValidationError` rather than `TypeError`, a non-string `unit` is rejected, and an unknown non-empty detail code is accepted as diagnostic data.

```ts
expect(() => parseDeliveryReceipt({ ...wireReceipt(), status: 'toString' })).toThrowError(
  DeliveryValidationError,
);
expect(serializeDeliveryReceipt(parseDeliveryReceipt(wireReceipt()))).toEqual(wireReceipt());
```

- [ ] **Step 2: Write failing receiver-mutation tests**

Require exact `+1` for changed durable state, reject a higher version with unchanged status/detail, reject `recovery_blocked -> rejected`, accept an exact duplicate, and keep terminal states terminal.

- [ ] **Step 3: Write failing sender-merge tests**

Require a higher version with a gap to replace the previous observation, a lower version to return the previous observation, exact duplicates to be idempotent, and same-version differing content to fail.

- [ ] **Step 4: Run receipt tests and verify RED**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- receipt.test.ts`

Expected: FAIL because the codec and merge API do not exist and current transition rules accept illegal mutations.

- [ ] **Step 5: Implement the safe wire parser and serializer**

Use an `isRecord(value: unknown)` guard, explicit primitive checks, own-property-safe status handling, canonical ID/hash/mint checks, and a known-detail/status map. Parse snake_case into the existing camelCase object. Accept unknown non-empty detail strings; serialize only validated internal receipts.

- [ ] **Step 6: Implement mutation and observation functions**

`assertReceiptTransition` allows exact duplicates; otherwise it requires identity equality, nonterminal prior state, `next.statusVersion === previous.statusVersion + 1`, changed status/detail, and no recovery-blocked rejection. `mergeObservedReceipt` validates both receipts, enforces identity, returns the prior receipt for stale input, rejects same-version conflicts, and returns a newer receipt even when intermediate versions were not observed.

- [ ] **Step 7: Run focused and full tests**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- receipt.test.ts`

Expected: PASS.

Run: `pnpm --filter @cashu-fault-lab/delivery-core test`

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/delivery-core/src/receipt.ts packages/delivery-core/src/index.ts packages/delivery-core/test/receipt.test.ts
git commit -m "fix: separate receipt parsing and state semantics"
```

### Task 3: Wire-Safe Fingerprints and Validated Points

**Files:**
- Modify: `packages/delivery-core/test/fingerprint.test.ts`
- Modify: `packages/delivery-core/src/fingerprint.ts`
- Modify: `packages/delivery-core/src/errors.ts`
- Modify: `packages/delivery-core/src/index.ts`
- Create: `spec/vectors/delivery-v1-fingerprints.json`

**Interfaces:**
- Produces: JSON-only `CashuProof`, `parseCompressedPoint(value)`, `encodePayloadFingerprint(input)`, `encodeProofSetFingerprint(input)`, and existing hash functions.

- [ ] **Step 1: Write failing JSON-model tests**

Require rejection of explicit `undefined`, `bigint`, maps, typed arrays, non-finite/fractional/unsafe numbers, invalid request IDs, empty units, more than 256 proofs, `createdAt >= expiresAt`, and windows longer than 86,400 seconds. Require equivalent proof map key order to remain equal.

```ts
expect(() =>
  computePayloadHash({ ...validInput(), proofs: [{ ...proofA, witness: undefined }] }),
).toThrowError(/JSON-compatible/i);
```

- [ ] **Step 2: Write failing point tests**

Require rejection of `02 || 00...00`, `02 || ff...ff`, wrong prefixes/lengths, and duplicate valid Y values. Require validated points to remain order-independent.

- [ ] **Step 3: Write failing known-answer vector test**

Load `spec/vectors/delivery-v1-fingerprints.json` and compare exact payload/proof-set CBOR hex plus SHA-256 hashes through public encoder/hash APIs.

- [ ] **Step 4: Run fingerprint tests and verify RED**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- fingerprint.test.ts`

Expected: FAIL for every new validation/vector behavior.

- [ ] **Step 5: Implement recursive JSON validation and fingerprint preimages**

Accept null, booleans, strings, safe integers, arrays, and plain string-keyed objects only. Reject an own property whose value is `undefined`. Validate required proof fields and timestamp/window constraints before CBOR encoding. Return defensive `Uint8Array` preimages from the encoder APIs; hashes call those encoders.

- [ ] **Step 6: Implement SEC1 validation**

Use `ECDH.convertKey(bytes, 'secp256k1', undefined, undefined, 'compressed')` inside `parseCompressedPoint`. Reject any conversion error or non-identical canonical compressed output. Sort defensive copies and reject adjacent duplicates before encoding the proof-set preimage.

- [ ] **Step 7: Generate and independently verify vectors**

Generate exact vector values with the TypeScript implementation, then cross-check the preimage and SHA-256 using an independent Python CBOR encoder in a temporary environment. Check in only public fake proofs and expected hex/digests.

- [ ] **Step 8: Run focused and full tests**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- fingerprint.test.ts`

Expected: PASS.

Run: `pnpm --filter @cashu-fault-lab/delivery-core test`

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/delivery-core/src packages/delivery-core/test/fingerprint.test.ts spec/vectors/delivery-v1-fingerprints.json
git commit -m "fix: harden deterministic delivery fingerprints"
```

### Task 4: Native Node Build and Consumer Contract

**Files:**
- Modify: `packages/delivery-core/package.json`
- Modify: `packages/delivery-core/src/*.ts`
- Modify: `packages/delivery-core/test/*.test.ts`
- Create: `packages/delivery-core/tsconfig.build.json`
- Create: `packages/delivery-core/test/consumer.mjs`
- Modify: `package.json`
- Modify: `turbo.json`

**Interfaces:**
- Produces: `packages/delivery-core/dist/index.js`, declarations, and a native consumer smoke command.

- [ ] **Step 1: Write the native consumer test**

`consumer.mjs` imports `../dist/index.js`, parses a known protocol ID, and exits successfully only when the public built API loads.

- [ ] **Step 2: Run the smoke test and verify RED**

Run: `node packages/delivery-core/test/consumer.mjs`

Expected: FAIL because `dist/index.js` does not exist.

- [ ] **Step 3: Add build configuration and Node-compatible specifiers**

Use `module`/`moduleResolution: NodeNext`, `rootDir: src`, `outDir: dist`, declarations, source maps, and emission enabled. Change internal relative imports/exports to `.js`. Point package `exports` and `types` at `dist`; add `build` and `test:consumer` scripts.

- [ ] **Step 4: Correct the Turbo task graph**

Add root `build` and `test:consumer` scripts. Give `build` the output `dist/**`; make `test` output-free rather than claiming `coverage/**`.

- [ ] **Step 5: Build and verify GREEN**

Run: `pnpm build`

Expected: PASS and create ESM/declarations in `dist`.

Run: `pnpm --filter @cashu-fault-lab/delivery-core test:consumer`

Expected: PASS under native Node 24.

- [ ] **Step 6: Run tests and type checking**

Run: `pnpm test && pnpm typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json turbo.json packages/delivery-core
git commit -m "build: publish native ESM delivery core"
```

### Task 5: Repository Quality Gate

**Files:**
- Create: `.prettierignore`
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore`
- Modify: `docs/superpowers/plans/2026-07-19-cashu-fault-lab-foundation.md`
- Modify: `docs/superpowers/plans/2026-07-19-delivery-core-hardening.md`

**Interfaces:**
- Produces: a reproducible local/CI verification gate.

- [ ] **Step 1: Add generated paths to formatting and Git ignores**

Ignore `node_modules`, `.turbo`, `coverage`, `dist`, `artifacts`, `pnpm-lock.yaml`, and `graphify-out` for formatting; add `dist/` and `graphify-out/` to Git ignore while retaining the lockfile.

- [ ] **Step 2: Format all authored files**

Run: `pnpm exec prettier --write .`

Expected: authored source/docs/config become stable while ignored generated files remain untouched.

- [ ] **Step 3: Add CI**

Use `actions/checkout`, `pnpm/action-setup@v4` with 11.15.0, and `actions/setup-node@v4` with Node 24 and pnpm caching. Run `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm --filter @cashu-fault-lab/delivery-core test:consumer`.

- [ ] **Step 4: Run the complete local gate**

Run: `pnpm format:check`

Run: `pnpm typecheck`

Run: `pnpm test`

Run: `pnpm build`

Run: `pnpm --filter @cashu-fault-lab/delivery-core test:consumer`

Run: `pnpm audit --prod`

Expected: every command exits 0 with no test/task warnings and no known production vulnerabilities.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .prettierignore .github docs package.json turbo.json packages spec pnpm-lock.yaml
git commit -m "ci: enforce delivery core quality gate"
```

## Completion Gate

- [ ] Every regression test was observed failing before its production fix.
- [ ] Exact fingerprint preimage and digest vectors pass.
- [ ] Receipt wire parsing never throws an unclassified runtime `TypeError` for malformed JSON.
- [ ] Receiver mutation and sender observation behavior are independently tested.
- [ ] Invalid/duplicate secp256k1 points are rejected.
- [ ] Native Node 24 imports only built package artifacts.
- [ ] Tests, typecheck, build, formatting, consumer smoke, and production audit all exit 0.
