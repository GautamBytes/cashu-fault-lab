# Cashu Fault Lab v0.1 Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repository internally ready for an experimental v0.1 developer preview by hardening adapter scaffolding, route-aware evidence, release-suite qualification, funded process-crash coverage, diagnostics, Docker context, and release materials.

**Architecture:** Keep contract validation in `adapter-contract`, scenario and release semantics in `scenario-runner`, orchestration in `lab-cli`, and funded restart controls inside the bundled cashu-ts adapter. Extend existing result types conservatively so a smoke-test matrix remains unchanged while release-policy execution requires named scenario evidence.

**Tech Stack:** Node.js 24, TypeScript 7, Vitest 4, Fastify 5, PostgreSQL 18, Docker Compose, Rust 1.97, Axum, pnpm 11, Turbo.

## Global Constraints

- Work only on `codex/release-hardening-v0-1`.
- Preserve the existing untracked `.pnpm-store/`.
- Follow red-green-refactor for every production-code change.
- Do not relax `spec/release-policy.json` to force a pass.
- Do not publish a tag, GitHub release, package, or upstream discussion.
- Crash controls are authenticated, disabled by default, bounded, and test-only.
- Never persist or report tokens, proof secrets, raw payload bytes, database URLs, or arbitrary upstream bodies.
- Node commands use Node.js 24.
- CDK remains `N/A` for restart-safe scenarios until its funded wallet state is durable.

---

### Task 1: Correct generated adapter contracts

**Files:**

- Modify: `apps/lab-cli/src/adapter-init.ts`
- Modify: `apps/lab-cli/test/adapter-init.test.ts`
- Test: `packages/adapter-contract/src/validation.ts`
- Reference: `spec/schemas/delivery-receipt.schema.json`
- Reference: `spec/schemas/adapter-capabilities.schema.json`

**Interfaces:**

- Consumes: `currentAdapterContract(): AdapterContractMetadata`
- Consumes: `validateAdapterResponse(operation, value): ValidationResult`
- Produces: generated capability JSON accepted by `validateAdapterResponse('capabilities', value)`
- Produces: generated receipt models with `status: processing | settled | rejected` and required `detail_code`

- [ ] **Step 1: Add failing template-contract tests**

Add imports for `validateAdapterResponse` and, for every generated language, parse
the emitted capability constant/file. Assert:

```ts
expect(validateAdapterResponse('capabilities', capabilities)).toEqual({ ok: true });
```

Also assert generated model text contains `processing`, does not contain the
receipt status literal `pending`, and does not make `detail_code` optional.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/adapter-init.test.ts
```

Expected: failure at `/implementation/sourceDigest` and failures for the receipt
status/detail-code assertions.

- [ ] **Step 3: Generate valid development identities**

Use the existing release-gate-aware helper:

```ts
const implementation = developmentIdentity({
  id: name,
  version: '0.1.0',
  language,
  runtime: language === 'rust' ? 'rust-1.97' : language === 'python' ? 'python-3.12' : 'node-24',
});
```

This produces non-placeholder schema-valid digests while ensuring
`isDevelopmentIdentity(implementation)` remains true. Add a generated README
statement that these are deterministic development identities, not release
provenance.

- [ ] **Step 4: Correct all three generated receipt models**

Use the canonical status literals and required detail-code field in TypeScript,
Rust, and Python templates. Keep JSON field casing aligned with OpenAPI.

- [ ] **Step 5: Verify GREEN**

Run the focused test and the adapter-contract tests:

```bash
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/adapter-init.test.ts
pnpm --filter @cashu-fault-lab/adapter-contract test
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add apps/lab-cli/src/adapter-init.ts apps/lab-cli/test/adapter-init.test.ts
git commit -m "fix: generate contract-valid adapter templates"
```

---

### Task 2: Validate generated projects through the real lab client

**Files:**

- Create: `scripts/verify-generated-adapter.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `apps/lab-cli/src/adapter-init.ts`
- Modify: `apps/lab-cli/test/adapter-init.test.ts`
- Modify: `apps/lab-cli/test/funded-wallet-workflows.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: generated project base URL and token from command arguments
- Consumes: built `HttpAdapterClient`
- Produces: a nonzero exit when capabilities, reset, authentication, or canonical `N/A` behavior drifts

- [ ] **Step 1: Add failing workflow-content test**

Require the generated-template workflow to invoke:

```text
node scripts/verify-generated-adapter.mjs
```

for TypeScript, Rust, and Python projects.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/funded-wallet-workflows.test.ts
```

Expected: workflow-content assertion fails.

- [ ] **Step 3: Implement the verifier**

The script must:

```js
const client = new HttpAdapterClient({ baseUrl, token });
await client.capabilities();
await client.reset('generated-adapter-conformance');
```

Then issue one unsupported operation and require
`AdapterNotApplicableError`. It must also perform an unauthenticated request and
require HTTP 401. Arguments are strict loopback origins, a non-empty token, and a
bounded startup timeout. It must not print the token.

Generated templates therefore implement authenticated reset as `{ "ok": true }`;
the five wallet/payment operations remain explicit canonical `N/A` stubs.

- [ ] **Step 4: Add generated server lifecycle to CI**

For each generated language:

1. start the built server in the background on a distinct loopback port;
2. retain its PID;
3. run the verifier;
4. terminate the PID in an `always` cleanup step;
5. keep existing build, unit-test, and Docker-build checks.

Do not use `eval`, `shell: true`, or a user-controlled executable.

- [ ] **Step 5: Verify GREEN**

```bash
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/funded-wallet-workflows.test.ts
pnpm docs:cli:check
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-generated-adapter.mjs .github/workflows/ci.yml package.json apps/lab-cli/test/funded-wallet-workflows.test.ts
git commit -m "test: verify generated adapters through lab client"
```

---

### Task 3: Make transport-fault evidence route-aware

**Files:**

- Modify: `packages/scenario-runner/src/external-adapter-driver.ts`
- Modify: `packages/scenario-runner/src/external-http-fault-controller.ts`
- Modify: `packages/scenario-runner/test/external-adapter-driver.test.ts`
- Modify: `packages/scenario-runner/test/external-http-fault-controller.test.ts`
- Modify: `packages/scenario-runner/test/cross-language-docker.test.ts`
- Modify: `apps/lab-cli/test/packaged-runtime.test.ts`

**Interfaces:**

- Produces:

```ts
interface ExternalFaultEvidence {
  readonly inbound: number;
  readonly forwarded: number;
  readonly controller: 'direct' | 'http-gateway';
  readonly observedTarget?: string;
}
```

- Produces: explicit `External configured fault was not exercised` failure
- Preserves: direct successful sends produce at least one runner-observed attempt

- [ ] **Step 1: Add a failing zero-gateway-counter regression test**

Run a no-fault external scenario with `evidence()` returning gateway counters
`0/0`. Assert the scenario passes and reports one runner-observed transport
attempt.

- [ ] **Step 2: Add a failing unexercised-fault test**

Configure an HTTP drop fault, return `0/0` controller evidence, and assert the
scenario fails with:

```text
External configured fault was not exercised
```

- [ ] **Step 3: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/external-adapter-driver.test.ts
```

Expected: the zero-counter test throws the positive-integer error and the
configured-fault test lacks the expected diagnostic.

- [ ] **Step 4: Track configured controller faults**

Store configured targets in the driver. Calculate:

```ts
const controllerAttempts = Math.max(evidence.inbound, evidence.forwarded);
const transportAttempts = Math.max(sendAttempts, controllerAttempts);
```

If a transport fault was configured and `controllerAttempts === 0`, fail before
emitting observations. Clear the tracked target when faults are cleared.

- [ ] **Step 5: Preserve controller provenance**

Return `controller` metadata from direct and HTTP controllers. Do not treat
runner attempts as proof that a configured gateway rule executed.

- [ ] **Step 6: Verify GREEN**

```bash
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/external-adapter-driver.test.ts test/external-http-fault-controller.test.ts
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/packaged-runtime.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/scenario-runner/src/external-adapter-driver.ts packages/scenario-runner/src/external-http-fault-controller.ts packages/scenario-runner/test/external-adapter-driver.test.ts packages/scenario-runner/test/external-http-fault-controller.test.ts apps/lab-cli/test/packaged-runtime.test.ts
git commit -m "fix: make external fault evidence route aware"
```

---

### Task 4: Preserve bounded, secret-safe sender diagnostics

**Files:**

- Modify: `apps/reference-sender/src/state.ts`
- Modify: `apps/reference-sender/src/send-payment.ts`
- Modify: `apps/reference-sender/src/postgres-state.ts`
- Modify: `apps/reference-sender/test/send-payment.test.ts`
- Modify: `apps/reference-sender/test/postgres-state.test.ts`
- Modify: `packages/report/src/redact.ts`
- Modify: `packages/report/test/report.test.ts`

**Interfaces:**

- Produces:

```ts
type SenderAttemptStage = 'transport' | 'receipt_validation';
type SenderAttemptCode =
  | 'TRANSPORT_FAILURE'
  | 'PERMANENT_FAILURE'
  | 'INVALID_RECEIPT'
  | 'RECEIPT_IDENTITY_CONFLICT'
  | 'RECEIPT_TRANSITION_CONFLICT';

interface SenderAttemptDiagnostic {
  readonly attempt: number;
  readonly transport: TransportTarget['type'];
  readonly stage: SenderAttemptStage;
  readonly code: SenderAttemptCode;
  readonly retryable: boolean;
}
```

- Extends `SenderDeliveryRecord` with `diagnostics?: readonly SenderAttemptDiagnostic[]`
- Maximum retained diagnostics: 20

- [ ] **Step 1: Add failing transport and receipt-diagnostic tests**

Assert a thrown transport error becomes `TRANSPORT_FAILURE` without preserving
its message. Assert malformed and identity-conflicting receipts receive distinct
codes. Include a secret-shaped error message and assert it is absent from the
record and rendered artifact.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/reference-sender exec vitest run test/send-payment.test.ts
```

Expected: no diagnostics exist.

- [ ] **Step 3: Replace empty catches with classification**

Add a pure classifier that returns enum-only diagnostics. Append with:

```ts
diagnostics: [...(record.diagnostics ?? []), diagnostic].slice(-20);
```

Do not store `Error.message`, stack, response body, payload, target URL, or
authorization data.

- [ ] **Step 4: Persist diagnostics safely**

Update encrypted PostgreSQL sender records and parsing. Reject unknown diagnostic
shapes as invalid durable state.

- [ ] **Step 5: Verify GREEN and redaction**

```bash
pnpm --filter @cashu-fault-lab/reference-sender exec vitest run test/send-payment.test.ts test/postgres-state.test.ts
pnpm --filter @cashu-fault-lab/report test
```

Expected: pass and secret-shaped strings absent.

- [ ] **Step 6: Commit**

```bash
git add apps/reference-sender/src/state.ts apps/reference-sender/src/send-payment.ts apps/reference-sender/src/postgres-state.ts apps/reference-sender/test/send-payment.test.ts apps/reference-sender/test/postgres-state.test.ts packages/report/src/redact.ts packages/report/test/report.test.ts
git commit -m "feat: retain safe sender attempt diagnostics"
```

---

### Task 5: Define and validate the release suite

**Files:**

- Create: `spec/release-suite.json`
- Create: `spec/schemas/release-suite.schema.json`
- Create: `packages/scenario-runner/src/release-suite.ts`
- Create: `packages/scenario-runner/test/release-suite.test.ts`
- Modify: `packages/scenario-runner/src/index.ts`
- Modify: `packages/adapter-contract/src/schemas.ts`
- Modify: `packages/adapter-contract/test/contract.test.ts`
- Modify: `spec/release-policy.json`
- Modify: `spec/schemas/release-policy.schema.json`

**Interfaces:**

- Produces:

```ts
interface ReleaseSuiteEntry {
  readonly id: string;
  readonly scenario: string;
  readonly transports: readonly AdapterTransport[];
  readonly senderDurability: DurabilityLevel;
  readonly receiverDurability: DurabilityLevel;
  readonly requiredInvariants: readonly InvariantId[];
}

interface ReleaseSuite {
  readonly schemaVersion: 1;
  readonly profile: string;
  readonly scenarios: readonly ReleaseSuiteEntry[];
}

function validateReleaseSuite(value: unknown): ReleaseSuite;
```

- [ ] **Step 1: Add failing manifest validation tests**

Cover valid parsing, unknown keys, duplicate IDs, traversal paths, duplicate
transports/invariants, unknown invariant IDs, and invalid durability.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/release-suite.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement the strict parser**

Use exact-key validation, safe path rules:

```ts
const SCENARIO_PATH = /^scenarios\/[a-z0-9/_-]+\.json$/u;
```

Require unique IDs and a non-empty scenario list. Reuse the oracle invariant
registry and adapter durability/transport unions.

- [ ] **Step 4: Check in the delivery-v1 suite**

List response-loss, duplicate, restart-after-settlement, four sender boundary
scenarios, and six receiver boundary scenarios. Each entry names only invariants
that its scenario is designed to observe.

- [ ] **Step 5: Extend release policy**

Advance the internal release-policy schema to version 2 and add:

```ts
readonly requiredScenarios: readonly string[];
```

Populate it with every release-suite scenario ID. Missing scenario evidence
must become a release-gate rejection, never a parser default.

- [ ] **Step 6: Verify GREEN**

```bash
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/release-suite.test.ts test/release-policy.test.ts
pnpm --filter @cashu-fault-lab/adapter-contract test
pnpm openapi:validate
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add spec/release-suite.json spec/schemas/release-suite.schema.json spec/release-policy.json spec/schemas/release-policy.schema.json packages/scenario-runner/src/release-suite.ts packages/scenario-runner/src/index.ts packages/scenario-runner/test/release-suite.test.ts packages/adapter-contract/src/schemas.ts packages/adapter-contract/test/contract.test.ts packages/scenario-runner/src/release-policy.ts packages/scenario-runner/test/release-policy.test.ts
git commit -m "feat: define delivery release scenario suite"
```

---

### Task 6: Carry per-scenario evidence through matrix results

**Files:**

- Modify: `packages/scenario-runner/src/matrix.ts`
- Modify: `packages/scenario-runner/src/release-policy.ts`
- Modify: `packages/scenario-runner/test/matrix.test.ts`
- Modify: `packages/scenario-runner/test/release-policy.test.ts`

**Interfaces:**

- Produces:

```ts
interface MatrixScenarioEvidence {
  readonly id: string;
  readonly seed: string;
  readonly status: 'passed' | 'failed' | 'not_applicable';
  readonly invariants: readonly InvariantResult[];
  readonly code?: string;
  readonly reason?: string;
}
```

- Extends successful `MatrixExecutionResult` and passed `MatrixCaseResult` with
  `scenarios: readonly MatrixScenarioEvidence[]`
- Adds release reason codes:
  `REQUIRED_SCENARIO_MISSING`, `REQUIRED_SCENARIO_NOT_PASSED`

- [ ] **Step 1: Add failing matrix cloning tests**

Assert scenario evidence is cloned into a passed matrix case and caller mutation
cannot alter the stored result.

- [ ] **Step 2: Add failing release-policy tests**

Require one rejection per missing or failed required scenario, with pair and
scenario IDs in the safe message.

- [ ] **Step 3: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/matrix.test.ts test/release-policy.test.ts
```

- [ ] **Step 4: Implement the result extension and fail-closed evaluation**

Default `scenarios` to an empty list for smoke cases. The release policy must not
interpret the empty list as historical compatibility; required scenarios are
missing and block qualification.

- [ ] **Step 5: Verify GREEN**

Run the focused tests and `pnpm --filter @cashu-fault-lab/scenario-runner test`.

- [ ] **Step 6: Commit**

```bash
git add packages/scenario-runner/src/matrix.ts packages/scenario-runner/src/release-policy.ts packages/scenario-runner/test/matrix.test.ts packages/scenario-runner/test/release-policy.test.ts
git commit -m "feat: require scenario evidence for release"
```

---

### Task 7: Execute release suites for external matrix pairs

**Files:**

- Create: `apps/lab-cli/src/release-suite-loader.ts`
- Create: `apps/lab-cli/test/release-suite-loader.test.ts`
- Modify: `apps/lab-cli/src/index.ts`
- Modify: `apps/lab-cli/src/packaged-runtime.ts`
- Modify: `apps/lab-cli/test/cli.test.ts`
- Modify: `apps/lab-cli/test/packaged-runtime.test.ts`
- Modify: `packages/report/src/matrix.ts`
- Modify: `packages/report/src/html.ts`
- Modify: `packages/report/src/junit.ts`
- Modify: `packages/report/test/report.test.ts`

**Interfaces:**

- `matrix(profile, seed, adapterManifest, releaseSuite?)`
- CLI option:

```text
--release-suite <path>
```

- When `--release-policy` is supplied without `--release-suite`, load
  `spec/release-suite.json`.

- [ ] **Step 1: Add failing safe-loader tests**

Test file-size limit, invalid JSON, schema rejection, scenario path confinement,
and missing scenario files. Resolve only repository-relative manifest paths; do
not accept manifest-controlled absolute paths or `..`.

- [ ] **Step 2: Add failing runtime execution test**

Provide two fake external participants and two suite scenarios. Assert each
otherwise executable pair runs both scenarios with deterministic distinct seeds
and retains both evidence records.

- [ ] **Step 3: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/release-suite-loader.test.ts test/packaged-runtime.test.ts test/cli.test.ts
```

- [ ] **Step 4: Implement deterministic execution**

Use:

```ts
seededProtocolId(matrixSeed, `release-suite:${senderId}:${receiverId}:${scenarioId}`);
```

as seed material. Execute through `ExternalAdapterScenarioDriver`. Convert failed
and `N/A` results without throwing away pair execution evidence.

- [ ] **Step 5: Render scenario blockers**

JSON retains structured records. JUnit emits one testcase per pair/scenario.
HTML and text show pair → scenario → invariant/reason. Escape all HTML/XML.

- [ ] **Step 6: Verify GREEN**

Run lab-cli and report package tests.

- [ ] **Step 7: Commit**

```bash
git add apps/lab-cli/src/release-suite-loader.ts apps/lab-cli/test/release-suite-loader.test.ts apps/lab-cli/src/index.ts apps/lab-cli/src/packaged-runtime.ts apps/lab-cli/test/cli.test.ts apps/lab-cli/test/packaged-runtime.test.ts packages/report/src/matrix.ts packages/report/src/html.ts packages/report/src/junit.ts packages/report/test/report.test.ts
git commit -m "feat: run release suite for matrix pairs"
```

---

### Task 8: Add optional authenticated crash-control contract

**Files:**

- Modify: `packages/adapter-contract/src/types.ts`
- Modify: `packages/adapter-contract/src/http-client.ts`
- Modify: `packages/adapter-contract/src/validation.ts`
- Modify: `packages/adapter-contract/src/schemas.ts`
- Modify: `spec/openapi.yaml`
- Modify: `spec/schemas/adapter-capabilities.schema.json`
- Create: `spec/schemas/crash-control.schema.json`
- Modify: `packages/adapter-contract/test/http-client.test.ts`
- Modify: `packages/adapter-contract/test/contract.test.ts`

**Interfaces:**

- Optional capability:

```ts
interface AdapterTestControls {
  readonly crashBoundaries: readonly CrashBoundary[];
}
```

- New separate client methods:

```ts
armCrash(input: {
  runId: string;
  component: 'sender' | 'receiver';
  boundary: CrashBoundary;
  occurrence: number;
}): Promise<void>;

crashStatus(): Promise<readonly {
  runId: string;
  component: 'sender' | 'receiver';
  boundary: CrashBoundary;
  occurrence: number;
  hits: number;
  consumed: boolean;
}[]>;
```

- Routes: authenticated `POST /v1/test/crashes` and `GET /v1/test/crashes`

- [ ] **Step 1: Add failing validation and client tests**

Cover every enum boundary, unknown keys, invalid occurrence, oversized body,
unauthorized response, disabled `501 N/A`, and redirect refusal.

- [ ] **Step 2: Verify RED**

Run adapter-contract tests.

- [ ] **Step 3: Implement strict schemas and client**

Reuse bearer authentication, response-size bounds, timeouts, redirect refusal,
and operation validation. Do not add crash methods to the required
`AdapterClient` interface; expose an optional `AdapterTestControlClient` so
third-party adapters remain compatible.

- [ ] **Step 4: Regenerate contract outputs**

Run `pnpm codegen` and `pnpm openapi:validate`. Review generated diffs.

- [ ] **Step 5: Verify GREEN and commit**

```bash
git add packages/adapter-contract spec/openapi.yaml spec/schemas
git commit -m "feat: add optional authenticated crash controls"
```

---

### Task 9: Implement durable PostgreSQL crash arms

**Files:**

- Create: `infra/migrations/003_crash_arms.sql`
- Create: `adapters/cashu-ts/src/postgres-crash-arm-store.ts`
- Create: `adapters/cashu-ts/test/postgres-crash-arm-store.test.ts`
- Modify: `adapters/cashu-ts/src/index.ts`

**Interfaces:**

```ts
interface CrashArm {
  readonly runId: string;
  readonly component: 'sender' | 'receiver';
  readonly boundary: CrashBoundary;
  readonly occurrence: number;
  readonly hits: number;
  readonly consumed: boolean;
}

interface CrashArmStore {
  arm(input: Omit<CrashArm, 'hits' | 'consumed'>): Promise<void>;
  hit(input: Pick<CrashArm, 'runId' | 'component' | 'boundary'>): Promise<boolean>;
  list(runId: string): Promise<readonly CrashArm[]>;
  reset(runId: string): Promise<void>;
}
```

- [ ] **Step 1: Add failing Testcontainers tests**

Cover arm/list, wrong boundary, occurrence counting, atomic one-shot consumption,
concurrent hits producing exactly one `true`, duplicate-arm conflict, reset, and
tenant/run isolation.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/adapter-cashu-ts exec vitest run test/postgres-crash-arm-store.test.ts
```

- [ ] **Step 3: Implement parameterized transactional SQL**

Use exact enum validation before queries. `hit` must lock the row, increment
`hits`, set `consumed = true` only at the requested occurrence, and return true
to exactly one caller. Never interpolate identifiers or values into SQL.

- [ ] **Step 4: Verify GREEN and commit**

```bash
git add infra/migrations/003_crash_arms.sql adapters/cashu-ts/src/postgres-crash-arm-store.ts adapters/cashu-ts/test/postgres-crash-arm-store.test.ts adapters/cashu-ts/src/index.ts
git commit -m "feat: persist one-shot crash arms"
```

---

### Task 10: Instrument all receiver crash boundaries

**Files:**

- Modify: `apps/reference-receiver/src/domain/accept-delivery.ts`
- Modify: `apps/reference-receiver/src/domain/recover-delivery.ts`
- Modify: `apps/reference-receiver/src/domain/types.ts`
- Modify: `apps/reference-receiver/src/ports/receiver-store.ts`
- Modify: `apps/reference-receiver/test/crash-recovery.test.ts`
- Modify: `apps/reference-receiver/test/fakes.ts`

**Interfaces:**

- Extend `AcceptDeliveryDependencies` with:

```ts
readonly crashCheckpoint?: CrashCheckpoint;
```

- Default to `noopCrashCheckpoint`
- No checkpoint changes the normal receipt/state behavior when unarmed

- [ ] **Step 1: Add one failing test per receiver boundary**

Use `createOneShotCrashCheckpoint`, run acceptance/recovery, assert
`CrashBoundaryHit`, then rerun with the same durable test store and assert:

- one mint redemption start;
- one merchant credit;
- stable delivery/payload identity;
- settled receipt after recovery.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/reference-receiver exec vitest run test/crash-recovery.test.ts
```

- [ ] **Step 3: Add checkpoints at exact state transitions**

Call receiver checkpoints before mint dispatch, after ambiguous dispatch,
before/after durable output persistence, before credit, and before final response.
Where the current atomic `settle` operation combines output persistence, credit,
and receipt, split only the internal store transaction into explicit checkpoint
phases while preserving atomic production behavior when no checkpoint is armed.
Test-only checkpoint exits may occur between committed phases, never in the
middle of an uncommitted SQL transaction.

- [ ] **Step 4: Verify GREEN and commit**

Run all reference-receiver unit and integration tests, then commit.

---

### Task 11: Wire cashu-ts crash controls and real process termination

**Files:**

- Modify: `adapters/cashu-ts/src/funded-server.ts`
- Modify: `adapters/cashu-ts/src/funded-operations.ts`
- Modify: `adapters/cashu-ts/src/funded-receiver-operations.ts`
- Modify: `adapters/cashu-ts/src/bin.ts`
- Modify: `adapters/cashu-ts/src/server.ts`
- Create: `adapters/cashu-ts/src/postgres-crash-checkpoint.ts`
- Modify: `adapters/cashu-ts/test/contract.test.ts`
- Modify: `adapters/cashu-ts/test/funded-operations.test.ts`
- Modify: `adapters/cashu-ts/test/funded-receiver-operations.test.ts`

**Interfaces:**

```ts
interface ProcessTerminator {
  terminate(): never;
}

class PostgresCrashCheckpoint implements CrashCheckpoint {
  hit(boundary: CrashBoundary, deliveryId: string): Promise<void>;
}
```

- [ ] **Step 1: Add failing disabled/authentication tests**

Without `CFL_CASHU_TS_TEST_CRASH_CONTROL=1`, crash routes return canonical
`501 N/A`. With the flag, missing/wrong bearer tokens return 401. Invalid bodies
return 422 without touching the store.

- [ ] **Step 2: Add failing checkpoint-termination test**

Inject a fake terminator. Arm a boundary, hit it twice, and assert the terminator
is invoked exactly once after the store reports durable consumption.

- [ ] **Step 3: Verify RED**

Run cashu-ts focused tests.

- [ ] **Step 4: Implement secure controls**

Register routes only behind explicit test-control configuration, reuse constant-
time bearer comparison, and use `process.kill(process.pid, 'SIGKILL')` only in
the production terminator selected by the funded Docker test environment.

- [ ] **Step 5: Inject checkpoint into both funded operations**

Use the already existing four sender calls and the six receiver calls from Task 10. Reset only arms for the active lab run.

- [ ] **Step 6: Verify GREEN and commit**

Run all cashu-ts and reference-receiver tests, then commit.

---

### Task 12: Execute all real funded crash-boundary scenarios

**Files:**

- Create: ten scenario files under `scenarios/crash-recovery/boundaries/`
- Modify: `packages/scenario-runner/src/external-adapter-driver.ts`
- Modify: `apps/lab-cli/src/packaged-runtime.ts`
- Modify: `infra/compose/wallet-adapters.compose.yml`
- Create: `packages/scenario-runner/test/funded-crash-boundaries.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/nightly.yml`

**Interfaces:**

- External fault controller gains optional:

```ts
armCrash(input: CrashArmInput): Promise<void>;
crashStatus(): Promise<readonly CrashArmStatus[]>;
```

- Scenario schema gains an authenticated lab command:

```ts
{ readonly type: 'arm_crash'; readonly component: 'sender' | 'receiver'; readonly boundary: CrashBoundary; readonly occurrence?: number }
```

- [ ] **Step 1: Add failing scenario-schema and runner tests**

Cover valid boundaries, invalid component/boundary combinations, default
occurrence, and a driver without crash controls returning `N/A`.

- [ ] **Step 2: Verify RED**

Run adapter-contract scenario-spec tests and scenario-runner tests.

- [ ] **Step 3: Implement arm-crash command**

The command records history, calls the authenticated control client, and requires
status evidence that the arm exists before starting delivery.

- [ ] **Step 4: Configure real container restarts**

Enable crash controls only in `wallet-adapters.compose.yml`, add an explicit
restart policy for cashu-ts, and retain loopback-only published ports. Do not
enable controls in production/default adapter startup.

- [ ] **Step 5: Add one scenario and funded test per boundary**

Each scenario arms one boundary, starts or sends the payment, waits through
process restart, resumes, asserts quiescence, and checks stable identity,
exclusive proof use, one credit, crash recovery, and reproducibility.

- [ ] **Step 6: Add strict funded script and CI lane**

Add the test to `test:funded:run`. CI must fail when Docker restart or boundary
evidence is unavailable; do not convert missing prerequisites to pass.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
pnpm test:integration
pnpm test:funded
```

Expected: all ten process-crash cases pass for funded cashu-ts. CDK restart-safe
cases remain explicit `N/A`.

---

### Task 13: Protect Docker build context

**Files:**

- Modify: `.dockerignore`
- Create: `scripts/docker-context.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Required ignore entries: `.worktrees`, `.worktrees/`, `.pnpm-store`, `.pnpm-store/`

- [ ] **Step 1: Add failing test**

Read `.dockerignore`, normalize non-comment entries, and require both directories
to be excluded. Add the test to `test:unit`.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/docker-context.test.mjs
```

- [ ] **Step 3: Add ignore rules**

Add exact root entries without changing unrelated ignore semantics.

- [ ] **Step 4: Verify GREEN and commit**

```bash
node --test scripts/docker-context.test.mjs
git add .dockerignore scripts/docker-context.test.mjs package.json
git commit -m "chore: exclude local stores from Docker context"
```

---

### Task 14: Prepare v0.1 release materials

**Files:**

- Modify: `package.json`
- Modify: `adapters/cashu-ts/package.json`
- Modify: `adapters/template/package.json`
- Modify: `apps/http-fault-gateway/package.json`
- Modify: `apps/lab-cli/package.json`
- Modify: `apps/nostr-fault-relay/package.json`
- Modify: `apps/reference-receiver/package.json`
- Modify: `apps/reference-sender/package.json`
- Modify: `packages/adapter-contract/package.json`
- Modify: `packages/delivery-core/package.json`
- Modify: `packages/nostr-delivery/package.json`
- Modify: `packages/oracle/package.json`
- Modify: `packages/report/package.json`
- Modify: `packages/scenario-runner/package.json`
- Modify: `adapters/cdk/Cargo.toml`
- Modify: `adapters/cdk/Cargo.lock`
- Create: `CHANGELOG.md`
- Create: `docs/releases/v0.1.0.md`
- Create: `docs/releases/v0.1.0-checklist.md`
- Create: `docs/examples/v0.1.0-demo.json`
- Create: `docs/examples/v0.1.0-demo.html`
- Modify: `README.md`
- Modify: `adapters/cashu-ts/README.md`
- Modify: `apps/lab-cli/README.md`
- Modify: `packages/adapter-contract/README.md`
- Modify: `packages/scenario-runner/README.md`
- Modify: `docs/cli-reference.md`

**Interfaces:**

- Internal project version: `0.1.0`
- Demo seed: `cashu-fault-lab-v0.1.0-demo`
- Demo artifacts contain no values matching configured test secrets

- [ ] **Step 1: Add failing release-metadata tests**

Create a Node test that asserts consistent workspace versions, required
developer-preview language, a deterministic demo command, and explicit blocked
external-certification checklist items.

- [ ] **Step 2: Verify RED**

Run the new release-metadata test.

- [ ] **Step 3: Update versions and documentation**

Describe what v0.1 solves, evidence tiers, release suite, supported adapters,
known `N/A` lanes, and the difference between preview and certification.

- [ ] **Step 4: Generate deterministic redacted artifacts**

Build the CLI, run the reference demo with the fixed seed, render JSON and HTML,
run secret-leak assertions, and check in only the redacted outputs.

- [ ] **Step 5: Verify docs and metadata**

```bash
pnpm docs:cli
pnpm docs:cli:check
pnpm codegen:check
pnpm openapi:validate
```

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml apps packages adapters CHANGELOG.md README.md docs
git commit -m "docs: prepare v0.1 developer preview"
```

---

### Task 15: Full correctness and security verification

**Files:**

- No planned file changes. If a verification command exposes a defect, add a
  failing regression test in the package owning that defect, then modify only
  the corresponding production file and record both paths in the plan checklist
  before editing.

- [ ] **Step 1: Verify repository state**

```bash
git status --short
git diff --check HEAD^
```

Only planned changes and the pre-existing `.pnpm-store/` may appear.

- [ ] **Step 2: Run Node checks under Node 24**

```bash
pnpm format:check
pnpm typecheck
pnpm exec turbo run test --force -- --exclude 'test/postgres-state.test.ts' --exclude 'test/postgres-store.test.ts' --exclude 'test/crash-recovery.test.ts' --exclude 'test/postgres-receiver-store.test.ts' --exclude 'test/postgres-crash-arm-store.test.ts' --exclude 'test/docker-mint-e2e.test.ts' --exclude 'test/docker-funded-e2e.test.ts' --exclude 'test/nostr-relay-e2e.test.ts' --exclude 'test/cross-language-docker.test.ts' --exclude 'test/funded-crash-boundaries.test.ts'
pnpm build
pnpm test:consumer
```

- [ ] **Step 3: Run integration and funded checks**

```bash
pnpm test:integration
pnpm test:funded
```

Require real Docker/PostgreSQL/mint execution; no silent skip for funded tests.

- [ ] **Step 4: Run Rust checks**

```bash
cargo fmt --manifest-path adapters/cdk/Cargo.toml --check
cargo clippy --manifest-path adapters/cdk/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path adapters/cdk/Cargo.toml
```

- [ ] **Step 5: Run contract, docs, dependency, and security checks**

```bash
pnpm codegen:check
pnpm openapi:validate
pnpm docs:cli:check
pnpm audit
pnpm test:browser
```

Manually confirm crash endpoints are absent/`N/A` without the explicit funded
flag, wrong tokens receive 401, request bodies are bounded, SQL is parameterized,
HTML/XML is escaped, and artifacts contain no configured secrets.

- [ ] **Step 6: Verify release behavior**

Run the smoke matrix and confirm it remains usable. Run the strict release matrix
and confirm it evaluates every named scenario while still failing honestly on
independent implementation/mint provenance gaps.

- [ ] **Step 7: Review final diff**

```bash
git diff --stat b299fa4
git diff --check b299fa4
git status --short --branch
```

- [ ] **Step 8: Commit verification-only fixes if any**

Each discovered defect receives its own regression test and focused commit. Do
not bundle unrelated cleanup.
