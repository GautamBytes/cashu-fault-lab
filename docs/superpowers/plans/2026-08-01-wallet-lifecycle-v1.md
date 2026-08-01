# Wallet Lifecycle V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, replayable `wallet-lifecycle-v1` suite that proves mint, swap, send, receive, melt, restore, and reconciliation preserve value across cashu-ts and CDK under faults.

**Architecture:** Add suite-specific core, contract, oracle, and runner packages while retaining the existing delivery packages unchanged. Wallet adapters expose a separate authenticated lifecycle API and persist operation identity before side effects; an implementation-independent oracle validates double-entry value evidence from wallet, mint, transport, and Lightning probes.

**Tech Stack:** Node.js 24, pnpm 11, strict TypeScript 7, Vitest 4, fast-check 4, JSON Schema 2020-12, Ajv 8, Fastify, PostgreSQL 17+, Rust/CDK, Docker Compose, Nutshell, mintd, and local Lightning regtest.

## Global Constraints

- No mainnet, public testnet, real funds, or public mint is permitted in automated tests.
- No production code is written before a focused test has failed for the expected reason.
- The lifecycle oracle imports no Cashu wallet library, adapter persistence, mint implementation, or delivery oracle.
- Raw proofs, secrets, seeds, quote IDs, NUT-20 private keys, signatures, preimages, and request bodies never enter persisted evidence.
- Existing delivery adapter and oracle behavior remains backward compatible.
- Unsupported optional NUTs are reported as `not_applicable`, never passed.
- All network destinations are configured and redirects are disabled.

---

### Task 1: Pure lifecycle identity and phase model

**Files:**

- Create: `packages/wallet-lifecycle-core/package.json`
- Create: `packages/wallet-lifecycle-core/tsconfig.json`
- Create: `packages/wallet-lifecycle-core/tsconfig.build.json`
- Create: `packages/wallet-lifecycle-core/src/types.ts`
- Create: `packages/wallet-lifecycle-core/src/operation.ts`
- Create: `packages/wallet-lifecycle-core/src/index.ts`
- Create: `packages/wallet-lifecycle-core/test/operation.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `parseOperationId(value: string): string`
- Produces: `createOperation(identity: LifecycleOperationIdentity): LifecycleOperationRecord`
- Produces: `transitionOperation(record, next, evidenceCode?): LifecycleOperationRecord`
- Produces: closed `LifecycleOperationKind` and `LifecyclePhase` unions.

- [x] **Step 1: Write failing tests for bounded IDs, immutable identity, allowed transitions, and rejected regressions.**

```ts
const created = createOperation({
  operationId: 'AAAAAAAAAAAAAAAAAAAAAA',
  kind: 'mint',
  mint: 'http://127.0.0.1:3338',
  unit: 'sat',
  intentHash: 'a'.repeat(64),
});
expect(transitionOperation(created, 'prepared').phase).toBe('prepared');
expect(() => transitionOperation(created, 'succeeded')).toThrow('invalid lifecycle transition');
```

- [x] **Step 2: Run `pnpm --filter @cashu-fault-lab/wallet-lifecycle-core test`; expect failure because the package implementation is absent.**
- [x] **Step 3: Implement the minimal closed state machine and strict validation without network or library dependencies.**
- [x] **Step 4: Re-run the focused tests and `pnpm --filter @cashu-fault-lab/wallet-lifecycle-core typecheck`; expect both to pass.**
- [x] **Step 5: Commit `feat(lifecycle): add immutable operation state model`.**

### Task 2: Double-entry lifecycle oracle

**Files:**

- Create: `packages/wallet-lifecycle-oracle/package.json`
- Create: `packages/wallet-lifecycle-oracle/tsconfig.json`
- Create: `packages/wallet-lifecycle-oracle/tsconfig.build.json`
- Create: `packages/wallet-lifecycle-oracle/src/model.ts`
- Create: `packages/wallet-lifecycle-oracle/src/commands.ts`
- Create: `packages/wallet-lifecycle-oracle/src/invariants.ts`
- Create: `packages/wallet-lifecycle-oracle/src/index.ts`
- Create: `packages/wallet-lifecycle-oracle/test/model.test.ts`
- Create: `packages/wallet-lifecycle-oracle/test/property.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: lifecycle identity and phase types from Task 1.
- Produces: `emptyLifecycleModel()`, `applyLifecycleObservation()`, `assertLifecycleSafety()`, and `assertLifecycleQuiescence()`.
- Produces: immutable posting, quote, proof-state, request-dispatch, and Lightning-settlement observations.

- [x] **Step 1: Write failing examples for idempotent effects, conflicting effect IDs, negative accounts, duplicate invoice settlement, stale quote observations, and request-digest mutation.**

```ts
const model = applyLifecycleObservation(emptyLifecycleModel(), {
  type: 'value_moved',
  operationId,
  effectId: 'funding-1',
  unit: 'sat',
  amount: 64,
  from: 'external:fixture',
  to: 'wallet:alice:available',
});
expect(() => assertLifecycleSafety(model)).not.toThrow();
```

- [x] **Step 2: Run the focused oracle tests; expect missing-export failures.**
- [x] **Step 3: Implement observation application and reconstruct safety state from the immutable observation log.**
- [x] **Step 4: Add fast-check command sequences proving duplicate observations are idempotent and invalid debits are rejected.**
- [x] **Step 5: Run tests and typecheck for both lifecycle packages; expect clean output.**
- [x] **Step 6: Commit `feat(lifecycle): add independent value conservation oracle`.**

### Task 3: Versioned language-neutral adapter contract

**Files:**

- Create: `spec/lifecycle-openapi.yaml`
- Create: `spec/schemas/lifecycle-capabilities.schema.json`
- Create: `spec/schemas/lifecycle-operation.schema.json`
- Create: `spec/schemas/lifecycle-wallet.schema.json`
- Create: `packages/wallet-lifecycle-contract/package.json`
- Create: `packages/wallet-lifecycle-contract/tsconfig.json`
- Create: `packages/wallet-lifecycle-contract/tsconfig.build.json`
- Create: `packages/wallet-lifecycle-contract/src/types.ts`
- Create: `packages/wallet-lifecycle-contract/src/validation.ts`
- Create: `packages/wallet-lifecycle-contract/src/http-client.ts`
- Create: `packages/wallet-lifecycle-contract/src/index.ts`
- Create: `packages/wallet-lifecycle-contract/test/contract.test.ts`
- Create: `packages/wallet-lifecycle-contract/test/http-client.test.ts`
- Modify: `scripts/validate-openapi.mjs`
- Modify: `scripts/codegen.mjs`

**Interfaces:**

- Produces: `LifecycleAdapterClient` with `capabilities`, `reset`, `start`, `resume`, `operation`, `wallet`, and `evidence` methods.
- Produces: a closed discriminated `LifecycleOperationInput` union and stable public error codes.

- [x] **Step 1: Write failing schema tests for unknown fields, unsafe integers, invalid URLs, missing operation discriminators, secret-bearing evidence fields, and unsupported capabilities.**
- [x] **Step 2: Run contract tests and confirm the intended validation failures.**
- [x] **Step 3: Add strict schemas, TypeScript types, Ajv validation, bounded authenticated HTTP calls, disabled redirects, and sanitized errors.**
- [x] **Step 4: Generate Rust and TypeScript models and verify generated files are deterministic.**
- [x] **Step 5: Run contract tests, OpenAPI validation, codegen check, and typecheck.**
- [x] **Step 6: Commit `feat(lifecycle): define versioned adapter contract`.**

### Task 4: Deterministic lifecycle runner and replay

**Files:**

- Create: `packages/wallet-lifecycle-runner/package.json`
- Create: `packages/wallet-lifecycle-runner/tsconfig.json`
- Create: `packages/wallet-lifecycle-runner/tsconfig.build.json`
- Create: `packages/wallet-lifecycle-runner/src/runner.ts`
- Create: `packages/wallet-lifecycle-runner/src/history.ts`
- Create: `packages/wallet-lifecycle-runner/src/replay.ts`
- Create: `packages/wallet-lifecycle-runner/src/matrix.ts`
- Create: `packages/wallet-lifecycle-runner/src/index.ts`
- Create: `packages/wallet-lifecycle-runner/test/runner.test.ts`
- Create: `packages/wallet-lifecycle-runner/test/replay.test.ts`
- Create: `packages/wallet-lifecycle-runner/test/matrix.test.ts`

**Interfaces:**

- Consumes: lifecycle contract clients and lifecycle oracle observations.
- Produces: seeded `LifecycleScenarioRunner`, replay artifacts, minimized command traces, and a capability-aware matrix.

- [x] **Step 1: Write a failing in-memory scenario proving a dropped mint response enters `ambiguous`, resumes the same operation ID, and records the same request digest.**
- [x] **Step 2: Run the focused test and verify the lifecycle runner is missing.**
- [x] **Step 3: Implement sequential commands, seeded scheduling, observation normalization, invariant checks after every command, and quiescent checks after faults stop.**
- [x] **Step 4: Write and pass a replay test comparing the complete normalized observation history and failure identity, not only invariant arrays.**
- [x] **Step 5: Add matrix tests requiring distinct implementation identities and explicit `not_applicable` results.**
- [x] **Step 6: Commit `feat(lifecycle): add deterministic scenario runner and replay`.**

### Task 5: Durable cashu-ts lifecycle adapter

**Files:**

- Create: `adapters/cashu-ts/src/lifecycle/types.ts`
- Create: `adapters/cashu-ts/src/lifecycle/postgres-store.ts`
- Create: `adapters/cashu-ts/src/lifecycle/operations.ts`
- Create: `adapters/cashu-ts/src/lifecycle/routes.ts`
- Create: `adapters/cashu-ts/test/lifecycle-operations.test.ts`
- Create: `adapters/cashu-ts/test/lifecycle-postgres.test.ts`
- Create: `infra/migrations/005_wallet_lifecycle.sql`
- Modify: `adapters/cashu-ts/src/server.ts`
- Modify: `adapters/cashu-ts/src/bin.ts`
- Modify: `adapters/cashu-ts/package.json`

**Interfaces:**

- Implements the lifecycle contract using cashu-ts APIs.
- Persists operation identity, exact request material encrypted at rest, proof reservations, output plans, and monotonic evidence.

- [ ] **Step 1: Write failing port-level tests for mint, swap, melt, send, receive, restore, and reconcile state transitions.**
- [ ] **Step 2: Add crash-focused store tests showing identity is durable before submission and concurrent resume obtains one row lock.**
- [ ] **Step 3: Implement the PostgreSQL journal with unique constraints on operation ID, effect ID, proof identity, and output-plan identity.**
- [ ] **Step 4: Implement cashu-ts operations one at a time, keeping external requests behind injected ports so each operation follows red-green TDD.**
- [ ] **Step 5: Add recovery tests for NUT-19 replay, quote polling, NUT-07 input state, NUT-09 restore, NUT-08 change, and `recovery_blocked`.**
- [ ] **Step 6: Add authenticated lifecycle routes and verify no secret-bearing value crosses the evidence API.**
- [ ] **Step 7: Run cashu-ts unit and PostgreSQL integration tests.**
- [ ] **Step 8: Commit `feat(cashu-ts): implement durable wallet lifecycle operations`.**

### Task 6: Durable CDK lifecycle adapter

**Files:**

- Create: `adapters/cdk/src/lifecycle.rs`
- Create: `adapters/cdk/src/lifecycle_store.rs`
- Create: `adapters/cdk/tests/lifecycle.rs`
- Modify: `adapters/cdk/src/lib.rs`
- Modify: `adapters/cdk/src/server.rs`
- Modify: `adapters/cdk/src/main.rs`
- Modify: `adapters/cdk/Cargo.toml`

**Interfaces:**

- Implements the same lifecycle contract through native CDK wallet APIs without calling TypeScript wallet code.

- [ ] **Step 1: Write failing Rust tests for identity persistence, concurrent resume, mint, swap, melt, send, receive, restore, and reconcile observations.**
- [ ] **Step 2: Implement encrypted SQLite persistence and transactional operation claiming.**
- [ ] **Step 3: Implement each CDK operation and recovery mapping with stable error codes and sanitized dependency errors.**
- [ ] **Step 4: Add contract-generated route handling and bounded authenticated responses.**
- [ ] **Step 5: Run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`.**
- [ ] **Step 6: Commit `feat(cdk): implement durable wallet lifecycle operations`.**

### Task 7: Semantic mint faults and scenario corpus

**Files:**

- Modify: `apps/http-fault-gateway/src/rules.ts`
- Modify: `apps/http-fault-gateway/src/proxy.ts`
- Modify: `apps/http-fault-gateway/src/control.ts`
- Modify: `apps/http-fault-gateway/test/gateway.test.ts`
- Create: `scenarios/wallet-lifecycle/mint-response-lost.json`
- Create: `scenarios/wallet-lifecycle/swap-response-lost.json`
- Create: `scenarios/wallet-lifecycle/melt-pending-restart.json`
- Create: `scenarios/wallet-lifecycle/melt-paid-response-lost.json`
- Create: `scenarios/wallet-lifecycle/receive-crash-before-save.json`
- Create: `scenarios/wallet-lifecycle/restore-duplicate.json`
- Create: `scenarios/wallet-lifecycle/concurrent-resume.json`
- Create: `scenarios/wallet-lifecycle/stale-quote.json`
- Create: `scenarios/wallet-lifecycle/security-quote-redaction.json`

**Interfaces:**

- Extends fault matching with operation ID, Cashu endpoint family, and attempt while preserving delivery rules.

- [ ] **Step 1: Write failing gateway tests for commit-then-drop, stale quote response, truncated response, and exact-body digest evidence.**
- [ ] **Step 2: Implement bounded semantic fault actions without recording request bodies.**
- [ ] **Step 3: Add and schema-validate the required lifecycle scenarios.**
- [ ] **Step 4: Run gateway and runner tests, including existing delivery regression tests.**
- [ ] **Step 5: Commit `feat(lifecycle): add semantic mint fault scenarios`.**

### Task 8: CLI, reports, and developer workflow

**Files:**

- Create: `apps/lab-cli/src/commands/lifecycle.ts`
- Create: `apps/lab-cli/test/lifecycle-cli.test.ts`
- Modify: `apps/lab-cli/src/command-registry.ts`
- Modify: `apps/lab-cli/src/doctor.ts`
- Modify: `packages/report/src/json.ts`
- Modify: `packages/report/src/junit.ts`
- Modify: `packages/report/src/html.ts`
- Modify: `packages/report/src/redact.ts`
- Modify: `packages/report/test/report.test.ts`
- Modify: `README.md`
- Modify: `apps/lab-cli/README.md`

**Interfaces:**

- Produces `lifecycle run`, `lifecycle matrix`, and `lifecycle replay` commands plus lifecycle doctor checks.

- [ ] **Step 1: Write failing CLI tests for command parsing, deterministic seed output, `N/A` reporting, and replay commands.**
- [ ] **Step 2: Write failing report tests with canary secrets for proofs, quotes, seeds, signatures, and preimages.**
- [ ] **Step 3: Implement the commands and lifecycle report views with stable exit codes.**
- [ ] **Step 4: Update concise quickstart documentation and generated CLI docs.**
- [ ] **Step 5: Run CLI, report, docs generation, format, and typecheck tests.**
- [ ] **Step 6: Commit `feat(cli): expose wallet lifecycle lab workflows`.**

### Task 9: Funded two-wallet/two-mint end-to-end matrix

**Files:**

- Create: `infra/compose/wallet-lifecycle.compose.yml`
- Modify: `infra/docker/wallet-adapters.Dockerfile`
- Create: `packages/wallet-lifecycle-runner/test/funded-lifecycle.test.ts`
- Modify: `scripts/test-environment.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Runs cashu-ts and CDK against pinned Nutshell and mintd fake-value backends and corroborates wallet evidence with mint state.

- [ ] **Step 1: Write a failing environment-contract test requiring four wallet/mint combinations and isolated persistent volumes.**
- [ ] **Step 2: Add the pinned Compose topology with loopback-only published ports and health checks.**
- [ ] **Step 3: Add funded mint, swap, send/receive, melt, and recovery matrix tests.**
- [ ] **Step 4: Restart adapters and mints at every declared crash boundary and require convergence.**
- [ ] **Step 5: Run the full funded matrix twice from clean volumes with fixed seeds.**
- [ ] **Step 6: Commit `test(lifecycle): add funded cross-library matrix`.**

### Task 10: Local Lightning regtest and release hardening

**Files:**

- Create: `infra/compose/lightning-regtest.compose.yml`
- Create: `packages/wallet-lifecycle-runner/test/regtest-melt.test.ts`
- Create: `spec/lifecycle-release-suite.json`
- Create: `spec/schemas/lifecycle-release-suite.schema.json`
- Modify: `packages/scenario-runner/src/release-policy.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `spec/threat-model.md`
- Modify: `docs/maintainers/release-checklist.md`

**Interfaces:**

- Adds an opt-in/nightly local regtest lane with an independently queried Lightning invoice sink and strict lifecycle release qualification.

- [ ] **Step 1: Write failing release-policy tests requiring two wallet identities, two mint identities, all mandatory invariants, replay evidence, and no skipped required scenarios.**
- [ ] **Step 2: Add pinned local Bitcoin and Lightning services; reject non-regtest chain identifiers.**
- [ ] **Step 3: Add melt tests proving one invoice settlement after timeout, duplicate resume, and adapter restart, including NUT-08 change conservation.**
- [ ] **Step 4: Add quote-theft, SSRF, redirect, oversized-input, stale-response, evidence-forgery, and redaction regression tests.**
- [ ] **Step 5: Run `pnpm test:all`, Rust checks, `pnpm typecheck`, `pnpm format:check`, `pnpm openapi:validate`, `pnpm codegen:check`, and `pnpm audit --prod`.**
- [ ] **Step 6: Perform a clean-checkout replay of one intentionally failing seed and compare the normalized failure artifact byte-for-byte.**
- [ ] **Step 7: Commit `feat(lifecycle): qualify wallet lifecycle v1 release lane`.**

## Final verification

- [ ] Confirm `git diff origin/main...HEAD` contains no unrelated release-hardening workspace changes.
- [ ] Confirm every required operation has unit, integration, crash, funded, and replay coverage.
- [ ] Confirm the artifact canary scan finds no proofs, quote IDs, seeds, signatures, preimages, tokens, or control credentials.
- [ ] Confirm delivery-v1 unit, integration, funded, and release-policy tests still pass unchanged.
- [ ] Record exact component versions and container digests in the lifecycle report.
