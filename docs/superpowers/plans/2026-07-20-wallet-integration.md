# Wallet Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register external wallet adapters without source changes and execute a real, funded cross-implementation Cashu delivery pair through the lab.

**Architecture:** A validated manifest creates authenticated `HttpAdapterClient` instances. The CLI/runtime discovers capabilities dynamically and drives sender/receiver pairs through the existing adapter contract, oracle, fault services, and reports. cashu-ts and CDK adapters implement real funded sender operations behind their existing HTTP servers; unsupported roles remain explicit `N/A`.

**Tech Stack:** Node.js 24, TypeScript 7, pnpm 11.15, Fastify 5, Ajv 8, Vitest 4, cashu-ts 4.7.2, Rust 1.97, Axum 0.8.9, CDK 0.17.3, Docker Compose.

## Global Constraints

- Follow red-green-refactor; no production behavior is added before its focused test fails for the expected reason.
- Preserve the seven-route adapter contract; funding remains an explicit lab-mode responsibility of `reset`.
- Adapter tokens come only from named environment variables and never enter artifacts, CLI arguments, or logs.
- Redirects are disabled and tokens are never forwarded to another origin.
- External adapters are untrusted; unsupported or insufficient evidence is `N/A`, never a pass.
- Built-in `reference-ts` behavior remains unchanged when `--adapters` is absent.
- Do not claim certification, T2, or T3 without the corresponding observable evidence.

---

### Task 1: Versioned Adapter Manifest

**Files:**

- Create: `apps/lab-cli/src/adapter-manifest.ts`
- Create: `apps/lab-cli/test/adapter-manifest.test.ts`
- Modify: `apps/lab-cli/src/index.ts`

**Interfaces:**

- Produces: `AdapterRegistration`, `AdapterManifest`, `ResolvedAdapterRegistration`, `parseAdapterManifest(value)`, and `resolveAdapterManifest(manifest, env)`.
- Consumes: no new runtime dependencies.

- [ ] **Step 1: Write failing manifest tests**

```ts
import { describe, expect, it } from 'vitest';
import { parseAdapterManifest, resolveAdapterManifest } from '../src/adapter-manifest.js';

describe('adapter manifest', () => {
  it('parses unique loopback adapters and resolves tokens from the environment', () => {
    const manifest = parseAdapterManifest({
      schemaVersion: 1,
      adapters: [{ id: 'cashu-ts', url: 'http://127.0.0.1:4101', tokenEnv: 'CFL_CASHU_TS_TOKEN' }],
    });
    expect(resolveAdapterManifest(manifest, { CFL_CASHU_TS_TOKEN: 'token-a' })).toEqual([
      { id: 'cashu-ts', url: 'http://127.0.0.1:4101', token: 'token-a' },
    ]);
  });

  it.each([
    { schemaVersion: 2, adapters: [] },
    { schemaVersion: 1, adapters: [] },
    { schemaVersion: 1, adapters: [{ id: 'A', url: 'http://127.0.0.1:1', tokenEnv: 'TOKEN' }] },
    { schemaVersion: 1, adapters: [{ id: 'a', url: 'https://wallet.example', tokenEnv: 'TOKEN' }] },
    {
      schemaVersion: 1,
      adapters: [{ id: 'a', url: 'http://127.0.0.1:1', tokenEnv: 'TOKEN', extra: true }],
    },
  ])('rejects unsafe or non-canonical manifest %#', (value) => {
    expect(() => parseAdapterManifest(value)).toThrow(/adapter manifest/i);
  });

  it('rejects duplicate IDs and missing token variables', () => {
    const manifest = parseAdapterManifest({
      schemaVersion: 1,
      adapters: [
        { id: 'wallet', url: 'http://127.0.0.1:4101', tokenEnv: 'TOKEN_A' },
        { id: 'wallet', url: 'http://127.0.0.1:4102', tokenEnv: 'TOKEN_B' },
      ],
    });
    expect(() => resolveAdapterManifest(manifest, {})).toThrow(/duplicate|TOKEN_A/i);
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/adapter-manifest.test.ts`  
Expected: FAIL because `adapter-manifest.js` does not exist.

- [ ] **Step 3: Implement the minimal parser and resolver**

```ts
export interface AdapterRegistration {
  readonly id: string;
  readonly url: string;
  readonly tokenEnv: string;
}

export interface AdapterManifest {
  readonly schemaVersion: 1;
  readonly adapters: readonly AdapterRegistration[];
}

export interface ResolvedAdapterRegistration {
  readonly id: string;
  readonly url: string;
  readonly token: string;
}

export function parseAdapterManifest(value: unknown): AdapterManifest;
export function resolveAdapterManifest(
  manifest: AdapterManifest,
  env: Readonly<Record<string, string | undefined>>,
): readonly ResolvedAdapterRegistration[];
```

Validation must reject unknown keys, non-loopback URLs, credentials, query strings, fragments, duplicate IDs, invalid environment-variable names, and missing/empty tokens.

- [ ] **Step 4: Verify GREEN and workspace types**

Run: `pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/adapter-manifest.test.ts && pnpm --filter @cashu-fault-lab/lab-cli typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/lab-cli/src/adapter-manifest.ts apps/lab-cli/test/adapter-manifest.test.ts
git commit -m "feat: validate external adapter manifests"
```

### Task 2: Authenticated HTTP Adapter Client

**Files:**

- Create: `packages/adapter-contract/src/http-client.ts`
- Create: `packages/adapter-contract/test/http-client.test.ts`
- Modify: `packages/adapter-contract/src/index.ts`

**Interfaces:**

- Produces: `HttpAdapterClient`, `AdapterClientError`, and `AdapterNotApplicableError`.
- Consumes: existing `AdapterClient`, request/response types, `validateAdapterRequest`, and `validateAdapterResponse`.

- [ ] **Step 1: Write failing client tests around a real loopback server**

```ts
const client = new HttpAdapterClient({ baseUrl, token: 'control-token', timeoutMs: 1_000 });
expect(await client.capabilities()).toMatchObject({ implementation: 'fixture' });
expect(await client.reset('seed-a')).toBeUndefined();
expect(seenAuthorization).toEqual(['Bearer control-token', 'Bearer control-token']);
```

Add independent tests that assert:

```ts
await expect(redirectingClient.capabilities()).rejects.toMatchObject({ code: 'ADAPTER_REDIRECT' });
await expect(invalidClient.capabilities()).rejects.toMatchObject({ code: 'ADAPTER_CONTRACT' });
await expect(unsupportedClient.ledger()).rejects.toBeInstanceOf(AdapterNotApplicableError);
await expect(slowClient.capabilities()).rejects.toMatchObject({ code: 'ADAPTER_TIMEOUT' });
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/adapter-contract exec vitest run test/http-client.test.ts`  
Expected: FAIL because `HttpAdapterClient` is not exported.

- [ ] **Step 3: Implement the minimal client**

```ts
export interface HttpAdapterClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

export class AdapterClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterClientError';
  }
}

export class AdapterNotApplicableError extends AdapterClientError {
  constructor(readonly reason: string) {
    super('ADAPTER_NOT_APPLICABLE', reason);
    this.name = 'AdapterNotApplicableError';
  }
}

export class HttpAdapterClient implements AdapterClient {
  capabilities(): Promise<AdapterCapabilities>;
  reset(seed: string): Promise<void>;
  createRequest(input: CreateRequestInput): Promise<PaymentRequestView>;
  send(input: SendPaymentInput): Promise<DeliveryReceiptView>;
  delivery(deliveryId: string): Promise<DeliveryReceiptView>;
  ledger(): Promise<readonly LedgerCreditView[]>;
  proofs(): Promise<readonly ProofEvidenceView[]>;
}
```

The private request helper must use `redirect: 'manual'`, `AbortSignal.timeout`, an exact configured origin, bounded body reads, JSON parsing, and contract validation. It must never retry.

- [ ] **Step 4: Verify GREEN and consumer import**

Run: `pnpm --filter @cashu-fault-lab/adapter-contract test && pnpm --filter @cashu-fault-lab/adapter-contract build && pnpm --filter @cashu-fault-lab/adapter-contract test:consumer`  
Expected: PASS with native ESM import of the built client.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-contract
git commit -m "feat: add secure HTTP adapter client"
```

### Task 3: Dynamic Adapter Registry and CLI Wiring

**Files:**

- Create: `apps/lab-cli/src/adapter-registry.ts`
- Create: `apps/lab-cli/test/adapter-registry.test.ts`
- Modify: `apps/lab-cli/src/index.ts`
- Modify: `apps/lab-cli/src/packaged-runtime.ts`
- Modify: `apps/lab-cli/test/cli.test.ts`

**Interfaces:**

- Produces: `ExternalAdapterRegistry.load(manifest, env)` and optional `adapterManifest` on `LabSelection`/matrix execution.
- Consumes: Tasks 1 and 2.

- [ ] **Step 1: Write failing registry and CLI tests**

```ts
const registry = await ExternalAdapterRegistry.load(manifest, env, { fetch });
expect(registry.ids()).toEqual(['cashu-ts', 'cdk']);
expect(registry.participants()).toEqual([
  { id: 'cashu-ts', capabilities: cashuCapabilities },
  { id: 'cdk', capabilities: cdkCapabilities },
]);
expect(registry.client('missing')).toBeUndefined();
```

Extend the CLI fixture to run:

```ts
await runCli(['node', 'cashu-fault-lab', 'matrix', '--adapters', 'adapters.json'], { runtime, io });
expect(runtime.adapterManifest).toEqual(parsedManifest);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/adapter-registry.test.ts test/cli.test.ts`  
Expected: FAIL because registry and `--adapters` do not exist.

- [ ] **Step 3: Implement registry and pass manifest through runtime calls**

```ts
export class ExternalAdapterRegistry {
  static async load(
    manifest: AdapterManifest,
    env: Readonly<Record<string, string | undefined>>,
    dependencies?: { readonly fetch?: typeof fetch },
  ): Promise<ExternalAdapterRegistry>;

  ids(): readonly string[];
  client(id: string): AdapterClient | undefined;
  participants(): readonly MatrixParticipant[];
}
```

Add `--adapters <path>` to `run` and `matrix`. Parse through `CliIo.readText`; do not read tokens through `CliIo`. Pass the parsed manifest to runtime while the runtime resolves tokens from its injected environment.

- [ ] **Step 4: Verify GREEN and preserve default behavior**

Run: `pnpm --filter @cashu-fault-lab/lab-cli test && pnpm --filter @cashu-fault-lab/lab-cli typecheck`  
Expected: PASS, including existing no-manifest reference tests.

- [ ] **Step 5: Commit**

```bash
git add apps/lab-cli
git commit -m "feat: discover external wallet adapters"
```

### Task 4: External Pair Matrix Executor

**Files:**

- Create: `packages/scenario-runner/src/external-pair.ts`
- Create: `packages/scenario-runner/test/external-pair.test.ts`
- Modify: `packages/scenario-runner/src/index.ts`
- Modify: `apps/lab-cli/src/packaged-runtime.ts`
- Modify: `apps/lab-cli/test/packaged-runtime.test.ts`

**Interfaces:**

- Produces: `runExternalDeliveryPair(input): Promise<MatrixExecutionResult>`.
- Consumes: two `AdapterClient` instances and existing oracle functions.

- [ ] **Step 1: Write failing pair tests using two real loopback adapter servers**

Test a successful sequence:

```ts
const result = await runExternalDeliveryPair({
  profile: 'delivery-v1',
  seed: 'pair-seed',
  sender,
  receiver,
  amount: 8,
  unit: 'sat',
});
expect(result).toMatchObject({ ok: true, evidence: { credits: 1, proofState: 'spent' } });
expect(calls).toEqual([
  'receiver.reset',
  'sender.reset',
  'receiver.request',
  'sender.send',
  'receiver.delivery',
  'receiver.ledger',
  'receiver.proofs',
]);
```

Add tests for `501 N/A`, conflicting receipt IDs, zero or duplicate credits, missing proof evidence, and an adapter exception. Each must return a stable failure or `N/A`, never throw raw dependency text.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/external-pair.test.ts`  
Expected: FAIL because `runExternalDeliveryPair` is missing.

- [ ] **Step 3: Implement the executor**

```ts
export interface ExternalDeliveryPairInput {
  readonly profile: string;
  readonly seed: string;
  readonly sender: AdapterClient;
  readonly receiver: AdapterClient;
  readonly amount: number;
  readonly unit: string;
}

export async function runExternalDeliveryPair(
  input: ExternalDeliveryPairInput,
): Promise<MatrixExecutionResult>;
```

The executor must compare request, receipt, ledger, and proof identities; assert exactly one credit; cap evidence to declared capabilities; and feed applicable observations through `applyObservation`, `assertSafety`, and `assertQuiescentLiveness`. Evidence includes implementation versions, seed, request ID, delivery ID, receipt status/version, credit count, and proof state, but no secrets.

- [ ] **Step 4: Wire dynamic matrices**

When a manifest is supplied, `PackagedLabRuntime.matrix` must use registry participants and invoke `runExternalDeliveryPair` for declared pairs. Without a manifest it must retain the current static preview matrix.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @cashu-fault-lab/scenario-runner test && pnpm --filter @cashu-fault-lab/lab-cli test`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/scenario-runner apps/lab-cli
git commit -m "feat: execute external wallet compatibility pairs"
```

### Task 5: External Scenario Driver and HTTP Fault Recovery

**Files:**

- Create: `packages/scenario-runner/src/external-adapter-driver.ts`
- Create: `packages/scenario-runner/test/external-adapter-driver.test.ts`
- Modify: `packages/scenario-runner/src/index.ts`
- Modify: `apps/lab-cli/src/packaged-runtime.ts`

**Interfaces:**

- Produces: `ExternalAdapterScenarioDriver` implementing `ScenarioDriver`.
- Consumes: registry-selected adapter clients and an injected fault controller.

- [ ] **Step 1: Write failing response-loss and duplicate tests**

```ts
const driver = new ExternalAdapterScenarioDriver({
  sender,
  receiver,
  faults,
  amount: 8,
  unit: 'sat',
});
const result = await new ScenarioRunner(driver).run(responseLostScenario, 'external-seed');
expect(result.status).toBe('passed');
expect(await receiver.ledger()).toHaveLength(1);
expect(faults.applied).toContainEqual({ target: 'http', kind: 'drop_response', occurrence: 1 });
```

The duplicate test must observe multiple transport attempts with one delivery ID, one proof-set hash, and one credit.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/external-adapter-driver.test.ts`  
Expected: FAIL because the driver is missing.

- [ ] **Step 3: Implement reset, request creation, send/resume, evidence collection, fault configuration, and cleanup**

```ts
export interface ExternalAdapterScenarioDriverOptions {
  readonly sender: AdapterClient;
  readonly receiver: AdapterClient;
  readonly faults: ExternalFaultController;
  readonly amount: number;
  readonly unit: string;
}

export class ExternalAdapterScenarioDriver implements ScenarioDriver {
  reset(seed: string): Promise<void>;
  capabilities(): Promise<Readonly<Record<string, unknown>>>;
  configureFault(target: string, rule: FaultRule): Promise<void>;
  send(sender: string, requestId: string): Promise<DriverSendResult>;
  restart(component: string): Promise<void>;
  clearFaults(target?: string): Promise<void>;
}
```

Unsupported restart operations return a stable `N/A` result for restart-specific lanes. They do not silently simulate a restart.

- [ ] **Step 4: Verify GREEN and CLI path**

Run: `pnpm --filter @cashu-fault-lab/scenario-runner test && pnpm --filter @cashu-fault-lab/lab-cli test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/scenario-runner apps/lab-cli
git commit -m "feat: drive external wallets through delivery faults"
```

### Task 6: Funded cashu-ts Sender Adapter

**Files:**

- Create: `adapters/cashu-ts/src/funded-operations.ts`
- Create: `adapters/cashu-ts/test/funded-operations.test.ts`
- Create: `adapters/cashu-ts/test/docker-funded-e2e.test.ts`
- Modify: `adapters/cashu-ts/src/server.ts`
- Modify: `adapters/cashu-ts/src/index.ts`
- Modify: `adapters/cashu-ts/package.json`

**Interfaces:**

- Produces: `FundedCashuTsOperations` implementing `CashuTsAdapterOperations` for the sender role and truthful T1 evidence.
- Consumes: cashu-ts `Wallet`, the existing delivery-core payload/receipt functions, and injected persistence/transport ports.

- [ ] **Step 1: Write failing wallet-operation tests**

Use an injected `CashuTsWalletPort` and real loopback receiver. Assert that reset funds once, the first send reserves one proof set, a second call with the same delivery ID reuses identical payload bytes, and a settled receipt releases the reservation.

```ts
expect(wallet.reserveCalls).toBe(1);
expect(transport.bodies).toHaveLength(2);
expect(new Set(transport.bodies).size).toBe(1);
expect(await operations.delivery(deliveryId)).toMatchObject({ status: 'settled' });
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/adapter-cashu-ts exec vitest run test/funded-operations.test.ts`  
Expected: FAIL because `FundedCashuTsOperations` is missing.

- [ ] **Step 3: Implement minimal persistent sender operations**

```ts
export interface CashuTsWalletPort {
  reset(seed: string): Promise<void>;
  reserve(amount: number, unit: string, mints: readonly string[]): Promise<readonly CashuProof[]>;
  markSettled(deliveryId: string): Promise<void>;
  evidence(deliveryId: string): Promise<ProofEvidenceView>;
}

export class FundedCashuTsOperations implements CashuTsAdapterOperations {
  reset(seed: string): Promise<void>;
  send(input: SendPaymentInput): Promise<DeliveryReceiptView>;
  delivery(deliveryId: string): Promise<DeliveryReceiptView>;
  ledger(): Promise<readonly LedgerCreditView[]>;
  proofs(): Promise<readonly ProofEvidenceView[]>;
}
```

Persist delivery ID, request ID, exact inner bytes, payload hash, reserved proofs, and highest receipt before network send. `ledger()` returns `N/A` for the sender-only role instead of an empty passing ledger.

- [ ] **Step 4: Add the real cashu-ts wallet driver and Docker mint test**

Use the proven fake-wallet funding sequence: `createMintQuoteBolt11`, poll to `PAID`, then `mintProofsBolt11`. Run against both pinned Nutshell and CDK mint URLs. No proof material may appear in assertion messages or artifacts.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @cashu-fault-lab/adapter-cashu-ts test && pnpm --filter @cashu-fault-lab/adapter-cashu-ts typecheck`  
Expected: PASS. With `CFL_REAL_MINT_URL` set, Docker funded test passes.

- [ ] **Step 6: Commit**

```bash
git add adapters/cashu-ts
git commit -m "feat: add funded cashu-ts sender adapter"
```

### Task 7: Funded CDK Sender Adapter

**Files:**

- Create: `adapters/cdk/src/funded.rs`
- Create: `adapters/cdk/tests/funded.rs`
- Modify: `adapters/cdk/src/lib.rs`
- Modify: `adapters/cdk/src/main.rs`
- Modify: `adapters/cdk/src/contract.rs`
- Modify: `adapters/cdk/Cargo.toml`

**Interfaces:**

- Produces: a Rust-owned funded sender path for `/v1/reset`, `/v1/send`, `/v1/deliveries/{id}`, and `/v1/proofs`.
- Consumes: CDK 0.17.3 `Wallet`, `WalletBuilder`, `prepare_send`, `PreparedSend::confirm`, and a pinned persistent CDK database backend.

- [ ] **Step 1: Write failing Rust state and route tests**

```rust
#[tokio::test]
async fn retry_reuses_one_reserved_token_and_delivery_id() {
    let operations = fixture_operations().await;
    let first = operations.send(send_input()).await.unwrap();
    let second = operations.send(send_input()).await.unwrap();
    assert_eq!(first.delivery_id, second.delivery_id);
    assert_eq!(operations.reserve_count().await, 1);
    assert_eq!(operations.unique_payload_count().await, 1);
}
```

Route tests must prove funded routes no longer return `501`, malformed IDs fail before wallet access, and bearer authentication remains mandatory.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path adapters/cdk/Cargo.toml funded`  
Expected: FAIL because the funded module and operations are missing.

- [ ] **Step 3: Implement CDK wallet reservation and exact-byte retry**

Use `WalletBuilder` with a seeded wallet and persistent store. `prepare_send(amount, SendOptions::default())` reserves proofs; `confirm(None)` produces the token once. Store the resulting proof payload and delivery metadata before HTTP delivery. Subsequent sends for the same delivery reuse stored bytes and never call `prepare_send` again.

- [ ] **Step 4: Implement fake-wallet mint funding during lab reset**

Create a Bolt11 mint quote, poll until paid, mint the quoted amount, and record only balance/count evidence. Errors map to stable adapter codes without invoice or proof material.

- [ ] **Step 5: Verify GREEN and lint**

Run: `cargo fmt --manifest-path adapters/cdk/Cargo.toml --check && cargo clippy --manifest-path adapters/cdk/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path adapters/cdk/Cargo.toml`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add adapters/cdk
git commit -m "feat: add funded CDK sender adapter"
```

### Task 8: Cross-Language Docker Lane, Evidence, and CI

**Files:**

- Create: `infra/compose/wallet-adapters.compose.yml`
- Create: `spec/examples/adapters.local.json`
- Create: `packages/scenario-runner/test/cross-language-docker.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/nightly.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `docs/adapter-guide.md`

**Interfaces:**

- Produces: one reproducible cashu-ts/CDK funded sender lane against a real reference receiver and real mint, plus honest achieved-tier metadata.
- Consumes: Tasks 1–7.

- [ ] **Step 1: Write the failing cross-language acceptance test**

The test starts registered adapters, runs direct delivery, committed-response loss, and duplicate delivery. Assert:

```ts
expect(matrixPair.status).toBe('passed');
expect(new Set(evidence.deliveryIds)).toHaveSize(1);
expect(evidence.redemptionStarts).toBe(1);
expect(evidence.creditCount).toBe(1);
expect(evidence.tier).toMatch(/T1|T2|T3/);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/cross-language-docker.test.ts`  
Expected: FAIL because the adapter compose stack is missing.

- [ ] **Step 3: Add pinned adapter services and example manifest**

Compose healthchecks must wait for `/v1/capabilities`; tokens come from Compose secrets/environment; adapter ports bind to loopback; the mint and receiver remain isolated on the lab network.

- [ ] **Step 4: Add CI lanes without weakening the release gate**

Pull-request CI runs one funded sender direction. Nightly runs both cashu-ts and CDK senders against both real mint implementations. The release gate still requires two qualifying independent pairs and must fail when the reverse receiver role remains `N/A`.

- [ ] **Step 5: Document exact external usage**

README commands must include startup, manifest creation, matrix, scenario, report, and cleanup. The adapter guide must explain role-specific evidence and why a sender-only adapter cannot claim T3.

- [ ] **Step 6: Run complete verification**

Run:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:consumer
pnpm audit --prod
pnpm test:browser
cargo fmt --manifest-path adapters/cdk/Cargo.toml --check
cargo clippy --manifest-path adapters/cdk/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path adapters/cdk/Cargo.toml
```

Expected: every command exits 0. Then run both pinned real-mint lanes and confirm one cross-language pair passes while unsupported roles remain `N/A`.

- [ ] **Step 7: Commit**

```bash
git add infra spec packages/scenario-runner .github README.md docs/adapter-guide.md
git commit -m "test: prove funded cross-language wallet delivery"
```

## Completion Gate

- The feature branch is clean.
- A clean checkout with no prebuilt `dist` passes install, typecheck, and tests.
- External adapters register without source edits.
- At least one real funded cross-language direction passes direct, duplicate, and lost-response delivery with one credit.
- Every remaining unsupported role is explicit `N/A` and the two-pair release gate remains closed.
- No new NUT or certification claim is made.
