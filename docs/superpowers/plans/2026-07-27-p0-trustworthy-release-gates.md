# P0 Trustworthy Release Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make default testing Docker-safe and make capability, invariant, and release claims depend on structured, independently checkable evidence.

**Architecture:** Introduce a breaking adapter capability schema v2 at the existing seven-route boundary, produce invariant results in the oracle/runner, and evaluate a declarative release policy over provenance-carrying matrix results. Keep developer matrix pass counts separate from the release gate and keep Docker-dependent suites in explicit test tiers.

**Tech Stack:** TypeScript 7, pnpm 11.15, Turbo 2.10, Vitest 4, AJV 2020-12, Fastify 5, Rust 1.97/CDK, Docker Compose, Testcontainers, GitHub Actions.

## Global Constraints

- Branch from `origin/main` and use the user-requested `feat/` prefix.
- Capability and scenario-result schema v2 are intentionally breaking; do not add a v1 compatibility decoder.
- `pnpm test` must not require Docker or external services.
- Integration tests skip only when the Docker daemon is unavailable; funded tests fail when prerequisites are unavailable.
- No adapter-claimed evidence can qualify a release pass.
- `matrix --min-passes` remains a developer convenience; release CI uses `--release-policy`.
- Every production behavior change follows a witnessed red-green test cycle.
- Do not weaken the existing redaction, loopback binding, or secret-handling controls.

---

### Task 1: Dependency remediation and explicit test tiers

**Files:**

- Create: `scripts/test-environment.mjs`
- Modify: `package.json`
- Modify: `turbo.json`
- Modify: `apps/reference-sender/package.json`
- Modify: `apps/reference-receiver/package.json`
- Modify: `adapters/cashu-ts/package.json`
- Modify: `packages/scenario-runner/package.json`
- Modify: `apps/lab-cli/src/doctor.ts`
- Modify: `apps/lab-cli/test/doctor.test.ts`
- Modify: `apps/lab-cli/test/cli.test.ts`
- Modify: `CONTRIBUTING.md`
- Modify: `README.md`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: root commands `test`, `test:unit`, `test:integration`, `test:funded`, `test:all`.
- Produces: `test-environment.mjs docker --skip-unavailable -- <command...>` and strict funded preflight mode.
- Produces: doctor checks named `test:unit`, `test:integration`, and `test:funded`.

- [ ] **Step 1: Add failing doctor tests for runnable test tiers**

```ts
it('prints the exact runnable test commands when Docker is healthy', async () => {
  const report = await runDoctor(healthyProbes());
  expect(report.checks).toContainEqual({
    name: 'test:unit',
    status: 'pass',
    detail: 'runnable: pnpm test:unit',
  });
  expect(report.checks).toContainEqual({
    name: 'test:integration',
    status: 'pass',
    detail: 'runnable: pnpm test:integration',
  });
});

it('marks integration skipped and funded blocked when Docker is unavailable', async () => {
  const report = await runDoctor(probesWithoutDocker());
  expect(report.checks).toContainEqual({
    name: 'test:integration',
    status: 'warn',
    detail: 'skipped: Docker daemon unavailable; run pnpm test:unit',
  });
  expect(report.checks).toContainEqual({
    name: 'test:funded',
    status: 'fail',
    detail: 'blocked: Docker daemon unavailable',
  });
});
```

- [ ] **Step 2: Run the focused tests and witness the missing tier failures**

Run: `pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/doctor.test.ts test/cli.test.ts`

Expected: FAIL because the tier checks are absent.

- [ ] **Step 3: Implement the test-tier preflight and scripts**

`scripts/test-environment.mjs` must probe `docker info --format {{.ServerVersion}}`, print one explicit skip line and exit zero only with `--skip-unavailable`, otherwise exit nonzero. It must spawn the command after `--` with inherited stdio when Docker is available.

Root scripts:

```json
{
  "test": "pnpm test:unit",
  "test:unit": "turbo run test:unit",
  "test:integration": "node scripts/test-environment.mjs docker --skip-unavailable -- pnpm exec turbo run test:integration",
  "test:funded": "node scripts/test-environment.mjs docker -- pnpm exec turbo run test:funded",
  "test:all": "pnpm test:unit && pnpm test:integration && pnpm test:funded"
}
```

Container-owning packages get explicit Vitest file lists. All other packages alias `test:unit` to their existing `vitest run`. Add matching Turbo tasks.

- [ ] **Step 4: Make doctor return tier readiness**

Derive tier checks from existing Docker, daemon, token, and endpoint checks. Unit is always runnable once the supported Node/pnpm checks pass. Integration is warning/skipped when Docker is unavailable. Funded is failed/blocked until all funded prerequisites pass.

- [ ] **Step 5: Update the lockfile**

Run: `pnpm update find-my-way@9.6.1 --lockfile-only`

Expected: `pnpm-lock.yaml` resolves Fastify's `find-my-way` to at least 9.6.1 without changing direct Fastify versions.

- [ ] **Step 6: Verify the tier tests and audit**

Run:

```bash
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/doctor.test.ts test/cli.test.ts
pnpm test
pnpm test:integration
pnpm audit --prod
```

Expected: focused tests pass; default tests pass without Docker; integration either runs or prints one skip reason and exits zero; audit reports zero production vulnerabilities.

- [ ] **Step 7: Document and commit**

Update test command semantics in README and CONTRIBUTING.

```bash
git add package.json turbo.json scripts/test-environment.mjs apps/reference-sender/package.json apps/reference-receiver/package.json adapters/cashu-ts/package.json packages/scenario-runner/package.json apps/lab-cli/src/doctor.ts apps/lab-cli/test/doctor.test.ts apps/lab-cli/test/cli.test.ts README.md CONTRIBUTING.md pnpm-lock.yaml
git commit -m "test: add explicit Docker-aware test tiers"
```

---

### Task 2: Adapter capability schema v2

**Files:**

- Modify: `packages/adapter-contract/src/types.ts`
- Modify: `packages/adapter-contract/src/index.ts`
- Modify: `spec/schemas/adapter-capabilities.schema.json`
- Modify: `spec/openapi.yaml`
- Modify: `packages/adapter-contract/test/contract.test.ts`
- Modify: `packages/adapter-contract/test/http-client.test.ts`

**Interfaces:**

- Produces: `AdapterImplementationIdentity`, `AdapterRoleCapability`, `AdapterMintIdentity`, `EvidenceSource`, and `DurabilityLevel`.
- Produces: `AdapterCapabilities` with required `schemaVersion: 2`, `implementation`, `roles`, `nuts`, `encodings`, and `mints`.

- [ ] **Step 1: Replace the contract fixture with a v2 capability and add v1 rejection tests**

```ts
const capabilitiesV2: AdapterCapabilities = {
  schemaVersion: 2,
  implementation: {
    id: 'memory-reference',
    version: '0.0.0',
    language: 'typescript',
    runtime: 'node-24',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    buildDigest: `sha256:${'b'.repeat(64)}`,
  },
  roles: {
    sender: {
      transports: ['http', 'nostr'],
      profiles: ['delivery-v1'],
      durability: 'process',
      evidence: { tier: 'T1', sources: ['runner', 'transport'] },
    },
    receiver: {
      transports: ['http', 'nostr'],
      profiles: ['delivery-v1'],
      durability: 'restart_safe',
      evidence: { tier: 'T3', sources: ['mint', 'durable_ledger', 'durable_state'] },
    },
  },
  nuts: [2, 3, 7, 9, 18, 19],
  encodings: ['creqA'],
  mints: [{ id: 'nutshell-local', implementation: 'nutshell', version: '0.17.0' }],
};
```

Assert the v2 response passes. Assert the old top-level `implementation`, `version`, `transports`, and `evidenceTier` object fails at `/schemaVersion` or for additional properties.

- [ ] **Step 2: Run the contract tests and witness schema/type failures**

Run: `pnpm --filter @cashu-fault-lab/adapter-contract exec vitest run test/contract.test.ts test/http-client.test.ts`

Expected: FAIL because schema v1 rejects the new object.

- [ ] **Step 3: Implement v2 types and JSON Schema**

Use the exact interfaces in the approved design. Require nonempty IDs and versions, normalized lowercase language/runtime identifiers, unique arrays, at least one role, and `^sha256:[0-9a-f]{64}$` digests. Set `additionalProperties: false` at every object level.

- [ ] **Step 4: Update OpenAPI and exports**

Make `/capabilities` examples and component schemas match the normative JSON Schema. Export all new types from the package index and remove `AdapterProfileCapability`.

- [ ] **Step 5: Run contract tests and typecheck**

Run:

```bash
pnpm --filter @cashu-fault-lab/adapter-contract test
pnpm --filter @cashu-fault-lab/adapter-contract typecheck
```

Expected: contract runtime and published schema alignment tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-contract spec/schemas/adapter-capabilities.schema.json spec/openapi.yaml
git commit -m "feat: introduce adapter capability schema v2"
```

---

### Task 3: Migrate every capability producer and consumer

**Files:**

- Modify: `adapters/cashu-ts/src/server.ts`
- Modify: `adapters/cashu-ts/src/funded-operations.ts`
- Modify: `adapters/cashu-ts/src/funded-receiver-operations.ts`
- Modify: `adapters/cashu-ts/test/*.test.ts`
- Modify: `adapters/template/src/server.ts`
- Modify: `adapters/template/test/server.test.ts`
- Modify: `apps/reference-receiver/src/funded-adapter.ts`
- Modify: `apps/reference-receiver/test/*.test.ts`
- Modify: `apps/reference-sender/test/adapter.test.ts`
- Modify: `apps/lab-cli/src/packaged-runtime.ts`
- Modify: `apps/lab-cli/test/*.test.ts`
- Modify: `packages/scenario-runner/src/*.ts`
- Modify: `packages/scenario-runner/test/*.test.ts`
- Modify: `adapters/cdk/src/contract.rs`
- Modify: `adapters/cdk/tests/*.rs`
- Modify: `spec/examples/*.json`
- Modify: `docs/adapter-guide.md`
- Modify: `packages/adapter-contract/README.md`

**Interfaces:**

- Consumes: capability v2 types from Task 2.
- Produces: truthful role-specific capabilities for every bundled adapter and reference runtime.

- [ ] **Step 1: Add focused failing tests for cashu-ts dual-role evidence**

Assert that the PostgreSQL-backed dual-role adapter advertises sender T1 and receiver T3, with receiver `restart_safe` durability and durable ledger/state evidence. Assert the in-memory variant advertises receiver T1 and process durability.

- [ ] **Step 2: Run the focused tests and witness the old global-tier failure**

Run: `pnpm --filter @cashu-fault-lab/adapter-cashu-ts exec vitest run test/funded-receiver-operations.test.ts test/postgres-receiver-store.test.ts`

Expected: FAIL because dual-role capabilities expose one top-level T1 tier.

- [ ] **Step 3: Add a deterministic identity helper**

Create one small adapter-contract helper:

```ts
export function developmentIdentity(input: {
  id: string;
  version: string;
  language: string;
  runtime: string;
}): AdapterImplementationIdentity;
```

It computes domain-separated SHA-256 source/build digests from locked identity fields. Production adapters may override these via build-time environment values validated against the same digest pattern.

- [ ] **Step 4: Migrate TypeScript producers and consumers**

Replace profile lookups with `capabilities.roles[role]?.profiles.includes(profile)`. Replace global transport and tier reads with the selected role. Preserve accurate T0/T1/T3 distinctions and mint configuration.

- [ ] **Step 5: Migrate the Rust CDK contract**

Use serde structures matching v2, advertise only `roles.sender`, Rust runtime identity, T1 sender evidence, HTTP transport, and configured CDK/Nutshell mint identity. Update Rust contract assertions to validate the complete v2 JSON.

- [ ] **Step 6: Migrate fixtures and docs**

Update manifests/examples, adapter guide, and package README. Remove all old `evidenceTier` and `profiles[].roles/status` examples.

- [ ] **Step 7: Run migration verification**

Run:

```bash
rg -n "evidenceTier|AdapterProfileCapability" adapters apps packages spec docs --glob '!docs/superpowers/**'
pnpm exec turbo run typecheck --force
pnpm exec turbo run test:unit --force
cargo test --manifest-path adapters/cdk/Cargo.toml
```

Expected: ripgrep has no old capability fields; all migrated TypeScript and Rust tests pass.

- [ ] **Step 8: Commit**

```bash
git add adapters apps packages spec docs
git commit -m "feat: publish truthful role-specific capabilities"
```

---

### Task 4: Oracle-owned invariant results and scenario artifact v2

**Files:**

- Create: `packages/oracle/src/evidence.ts`
- Create: `packages/oracle/test/evidence.test.ts`
- Modify: `packages/oracle/src/index.ts`
- Modify: `packages/scenario-runner/src/runner.ts`
- Modify: `packages/scenario-runner/src/replay.ts`
- Modify: `packages/scenario-runner/test/runner.test.ts`
- Modify: `packages/scenario-runner/test/replay.test.ts`
- Modify: `packages/report/src/redact.ts`
- Modify: `packages/report/test/report.test.ts`
- Modify: `spec/schemas/scenario-result.schema.json`
- Modify: `spec/invariants.md`

**Interfaces:**

- Produces: `InvariantId`, `InvariantResult`, `InvariantEvidenceReference`, `evaluateInvariants()`, and `INVARIANT_REGISTRY`.
- Produces: artifact `schemaVersion: 2` with required `invariants`.

- [ ] **Step 1: Add failing oracle tests for evidence classification**

Cover at minimum:

```ts
expect(result('at-most-one-merchant-credit-per-delivery')).toMatchObject({
  status: 'passed',
  confidence: 'observed',
  evidence: [expect.objectContaining({ source: 'ledger' })],
});

expect(result('independent-mint-evidence')).toMatchObject({
  status: 'not_observable',
  reason: expect.stringContaining('mint proof evidence'),
});

expect(result('crash-recovery')).toMatchObject({
  status: 'not_applicable',
});
```

- [ ] **Step 2: Run the evidence tests and witness the missing evaluator**

Run: `pnpm --filter @cashu-fault-lab/oracle exec vitest run test/evidence.test.ts`

Expected: FAIL because the registry/evaluator exports do not exist.

- [ ] **Step 3: Implement the 18-entry registry and evaluator**

Use exact IDs from `spec/invariants.md`. Evaluation must be pure, deterministic, exhaustive, and return one result per registry entry. Reuse model observations and existing safety/liveness logic rather than duplicating state transitions.

- [ ] **Step 4: Add failing runner/report artifact-v2 tests**

Assert a completed reference scenario contains 18 invariant results, schema version 2, stable evidence references, and that report output equals the artifact's invariant results after redaction. Assert no synthetic `scenario-conformance` entry exists.

- [ ] **Step 5: Run focused runner/report tests and witness v1 failures**

Run:

```bash
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/runner.test.ts test/replay.test.ts
pnpm --filter @cashu-fault-lab/report exec vitest run test/report.test.ts
```

Expected: FAIL because artifacts/reports remain v1.

- [ ] **Step 6: Wire artifact v2 and report pass-through**

Call `evaluateInvariants` after scenario execution, attach results to the artifact, require them in replay/schema validation, and let report redaction allowlist only the typed invariant fields and safe evidence descriptions.

- [ ] **Step 7: Verify deterministic evidence and redaction**

Run:

```bash
pnpm --filter @cashu-fault-lab/oracle test
pnpm --filter @cashu-fault-lab/scenario-runner test:unit
pnpm --filter @cashu-fault-lab/report test
```

Expected: evaluator, replay, report, and secret-redaction tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/oracle packages/scenario-runner packages/report spec/schemas/scenario-result.schema.json spec/invariants.md
git commit -m "feat: emit oracle-owned invariant evidence"
```

---

### Task 5: Provenance-aware release policy

**Files:**

- Create: `packages/scenario-runner/src/release-policy.ts`
- Create: `packages/scenario-runner/test/release-policy.test.ts`
- Create: `spec/release-policy.json`
- Create: `spec/schemas/release-policy.schema.json`
- Modify: `packages/scenario-runner/src/matrix.ts`
- Modify: `packages/scenario-runner/src/external-pair.ts`
- Modify: `packages/scenario-runner/src/index.ts`
- Modify: `packages/scenario-runner/test/matrix.test.ts`
- Modify: `packages/scenario-runner/test/external-pair.test.ts`

**Interfaces:**

- Produces: `ReleasePolicy`, `ReleaseGateResult`, `ReleaseGateReason`, `evaluateReleasePolicy()`, and `validateReleasePolicy()`.
- Extends passed `MatrixCaseResult` with sender/receiver capability snapshots, mint identity, and invariant results.

- [ ] **Step 1: Add failing release-policy tests**

Test:

- A valid pair passes pair-level checks.
- Same implementation fails `CROSS_IMPLEMENTATION_REQUIRED`.
- Same language fails `CROSS_LANGUAGE_REQUIRED`.
- Same build aliases deduplicate.
- Insufficient sender/receiver evidence fails with role-specific codes.
- Adapter-claimed required invariant fails.
- Missing required invariant fails.
- One qualifying pair fails minimum count.
- One distinct mint fails minimum mint count.
- Two independent pairs/two mints pass.

- [ ] **Step 2: Run the tests and witness missing policy behavior**

Run: `pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/release-policy.test.ts`

Expected: FAIL because release-policy exports do not exist.

- [ ] **Step 3: Implement policy schema, validator, and evaluator**

Use the exact policy document from the approved design. Return all stable rejection codes in deterministic sender/receiver/code order; never stop at the first rejection.

- [ ] **Step 4: Add provenance to matrix passes**

`CompatibilityMatrix` copies validated sender and receiver capability snapshots into passing cases. `runExternalDeliveryPair` feeds collected receipt, ledger, proof, mint, transport, seed, and invariant evidence through the same oracle evidence model used by scenario runs.

- [ ] **Step 5: Verify policy and matrix behavior**

Run:

```bash
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/release-policy.test.ts test/matrix.test.ts test/external-pair.test.ts
```

Expected: all positive, negative, alias, evidence-floor, and external-pair tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/scenario-runner spec/release-policy.json spec/schemas/release-policy.schema.json
git commit -m "feat: enforce provenance-aware release policy"
```

---

### Task 6: CLI, reports, and CI release integration

**Files:**

- Modify: `apps/lab-cli/src/index.ts`
- Modify: `apps/lab-cli/src/packaged-runtime.ts`
- Modify: `apps/lab-cli/test/cli.test.ts`
- Modify: `apps/lab-cli/test/packaged-runtime.test.ts`
- Modify: `packages/report/src/matrix.ts`
- Modify: `packages/report/src/json.ts`
- Modify: `packages/report/src/junit.ts`
- Modify: `packages/report/src/html.ts`
- Modify: `packages/report/test/report.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `apps/lab-cli/README.md`
- Modify: `spec/threat-model.md`

**Interfaces:**

- Produces: CLI option `matrix --release-policy <path>`.
- Produces: matrix report schema v2 with optional `releaseGate`.

- [ ] **Step 1: Add failing CLI/report tests**

Assert:

- A malformed policy exits nonzero before `runtime.matrix` is invoked.
- A negative packaged matrix prints every structured rejection reason and exits one.
- A positive fixture exits zero.
- JSON/JUnit/HTML include gate pass/fail and rejection codes.
- `--min-passes` still works when no release policy is supplied.

- [ ] **Step 2: Run focused tests and witness missing option/report fields**

Run:

```bash
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/cli.test.ts test/packaged-runtime.test.ts
pnpm --filter @cashu-fault-lab/report exec vitest run test/report.test.ts
```

Expected: FAIL because the release-policy option and report fields are missing.

- [ ] **Step 3: Implement CLI and report integration**

Read and validate the policy before running adapters. Evaluate after matrix completion. Text output prints one line per reason. Non-text renderers receive the gate result. Exit nonzero when ordinary matrix failures or the release gate fail.

- [ ] **Step 4: Update workflows and documentation**

Replace release workflow `--min-passes 2` with:

```bash
node apps/lab-cli/dist/bin.js matrix \
  --profile delivery-v1 \
  --release-policy spec/release-policy.json
```

Keep developer CI pass-count checks where they are not release claims. Reconcile README, CLI commands, coverage table, and threat model.

- [ ] **Step 5: Verify CLI/report/workflow behavior**

Run:

```bash
pnpm --filter @cashu-fault-lab/lab-cli test
pnpm --filter @cashu-fault-lab/report test
node apps/lab-cli/dist/bin.js matrix --profile delivery-v1 --release-policy spec/release-policy.json
```

Expected: tests pass; packaged reference matrix exits one with structured independence, evidence, count, and mint reasons.

- [ ] **Step 6: Commit**

```bash
git add apps/lab-cli packages/report .github README.md spec/threat-model.md
git commit -m "feat: expose release policy in CLI and reports"
```

---

### Task 7: Full verification and branch audit

**Files:**

- Modify only files required by verification findings.

**Interfaces:**

- Consumes all prior tasks.
- Produces final evidence that the branch satisfies the approved design.

- [ ] **Step 1: Run clean static and dependency verification**

```bash
pnpm audit --prod
pnpm format:check
pnpm exec turbo run typecheck --force
pnpm exec turbo run build --force
pnpm exec turbo run test:consumer --force
```

Expected: every command exits zero with no production advisories.

- [ ] **Step 2: Verify Docker-safe defaults**

Run with the Docker socket unavailable:

```bash
pnpm test
pnpm test:integration
```

Expected: unit tests pass; integration prints an explicit skipped-tier reason and exits zero.

- [ ] **Step 3: Run integration and funded E2E**

```bash
pnpm test:integration
pnpm test:funded
pnpm test:browser
```

Expected: all configured PostgreSQL, real-mint, restart, transport, and browser lanes pass. If the local Docker daemon is unavailable, funded verification remains explicitly blocked and cannot be reported as passing.

- [ ] **Step 4: Run Rust verification**

```bash
cargo fmt --manifest-path adapters/cdk/Cargo.toml --check
cargo clippy --manifest-path adapters/cdk/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path adapters/cdk/Cargo.toml
```

Expected: formatting, lint, and tests exit zero.

- [ ] **Step 5: Verify release gate positive and negative E2E**

Run the positive fixture policy test and the packaged reference-only CLI command. Expected: positive fixture passes; packaged matrix exits one and lists structured reasons.

- [ ] **Step 6: Audit the diff and commits**

```bash
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, clean status, and focused commits for design, test tiers, capability v2, invariant evidence, release policy, and CLI/CI integration.
