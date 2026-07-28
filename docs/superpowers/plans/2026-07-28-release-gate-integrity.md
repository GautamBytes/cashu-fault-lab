# Release Gate Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make strict qualification accept independently observed external evidence while cryptographically binding, conservatively aggregating, and exactly attributing every release-suite result.

**Architecture:** Source-specific oracle confidence prevents derivations from laundering adapter claims. Optional, separate read-only evidence authorities provide ledger and mint observations, while the runner-controlled gateway supplies exact transport/fault evidence. A SHA-256 suite bundle digest and conservative invariant aggregation bind the policy to the exact scenarios it evaluates.

**Tech Stack:** TypeScript 7, Node.js 24, pnpm workspaces, Vitest, Node test runner, JSON Schema, GitHub Actions, Rust 1.97 verification.

## Global Constraints

- Work only on `codex/release-gate-integrity`, based on `origin/main`.
- Preserve the atomic receiver settlement transaction and realpath confinement.
- `adapter_claimed` evidence never qualifies under the checked-in policy.
- Existing developer matrices remain runnable without evidence authorities.
- Never expose tokens, proof material, delivery identifiers, or request bodies in gateway evidence.
- Do not publish a tag, GitHub release, package, or certification claim.
- Production code follows a witnessed red-green-refactor cycle.

---

### Task 1: Source-specific oracle confidence

**Files:**
- Modify: `packages/oracle/src/evidence.ts`
- Modify: `packages/oracle/src/index.ts`
- Test: `packages/oracle/test/evidence.test.ts`
- Modify: `packages/scenario-runner/src/runner.ts`
- Test: `packages/scenario-runner/test/runner.test.ts`

**Interfaces:**
- Produces: `EvidenceSourceConfidence`
- Produces: `EvaluateInvariantsInput.sourceConfidence`
- Produces: `ScenarioDriver.sourceConfidence`
- Keeps: `observationConfidence` as a compatibility fallback until all callers migrate.

- [ ] **Step 1: Write failing tests**

Add tests proving a derived invariant becomes `adapter_claimed` when one of its
referenced sources is adapter-claimed, stays `derived` when all referenced
sources are observed, and that `ScenarioRunner` forwards a driver's
source-confidence map.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm --filter @cashu-fault-lab/oracle exec vitest run test/evidence.test.ts
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/runner.test.ts
```

Expected: failures because `sourceConfidence` is not accepted or applied.

- [ ] **Step 3: Implement the minimal confidence propagation**

Add:

```ts
export type EvidenceSourceConfidence = Readonly<
  Partial<
    Record<
      InvariantEvidenceSource,
      Extract<EvidenceConfidence, 'observed' | 'adapter_claimed'>
    >
  >
>;
```

For each passed invariant, inspect only its evidence references. If any
referenced source resolves to `adapter_claimed`, set result confidence to
`adapter_claimed`; otherwise preserve `observed` or `derived`. Forward the
driver's map from `ScenarioRunner` into `evaluateInvariants`.

- [ ] **Step 4: Verify GREEN and refactor**

Run both focused suites again and keep the full invariant registry deterministic.

- [ ] **Step 5: Commit**

```bash
git add packages/oracle packages/scenario-runner/src/runner.ts packages/scenario-runner/test/runner.test.ts
git commit -m "feat: track invariant confidence by evidence source"
```

### Task 2: Independent external evidence authorities

**Files:**
- Modify: `apps/lab-cli/src/adapter-manifest.ts`
- Test: `apps/lab-cli/test/adapter-manifest.test.ts`
- Modify: `apps/lab-cli/src/adapter-registry.ts`
- Test: `apps/lab-cli/test/adapter-registry.test.ts`
- Modify: `packages/scenario-runner/src/external-adapter-driver.ts`
- Test: `packages/scenario-runner/test/external-adapter-driver.test.ts`
- Modify: `apps/lab-cli/src/packaged-runtime.ts`
- Modify: `apps/lab-cli/test/packaged-runtime.test.ts`
- Modify: `spec/examples/adapters.local.json`
- Modify: `docs/adapter-guide.md`
- Modify: `README.md`

**Interfaces:**
- Produces: manifest schema version 2 with optional `evidence.ledger` and `evidence.mint`.
- Produces: `ExternalEvidenceAuthorities` with read-only `ledger()` and `proofs()`.
- Produces: `ExternalAdapterRegistry.evidence(adapterId)`.
- Consumes: `ScenarioDriver.sourceConfidence` from Task 1.

- [ ] **Step 1: Write failing manifest and registry tests**

Test a valid v2 manifest without authorities, a valid manifest with distinct
ledger/mint origins, rejection of unknown fields, missing authority tokens, and
authority origins equal to the adapter control origin.

- [ ] **Step 2: Verify manifest tests RED**

```bash
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/adapter-manifest.test.ts test/adapter-registry.test.ts
```

Expected: schema-version/evidence-field failures.

- [ ] **Step 3: Implement manifest resolution and read-only clients**

Resolve authority tokens independently. Reuse the validated adapter HTTP client
only for `ledger()` and `proofs()` calls and expose a narrow authority object.
Do not call authority mutation or capability endpoints.

- [ ] **Step 4: Write failing driver trust tests**

Prove:

- wallet ledger/proof observations remain `adapter_claimed`;
- independent authorities make ledger/proof sources observed;
- direct transport keeps receipt evidence adapter-claimed;
- exact runner-gateway transport can make its recorded receipt/timeline
  observations observed;
- missing authorities fail strict policy without breaking a smoke matrix.

- [ ] **Step 5: Verify driver tests RED**

```bash
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/external-adapter-driver.test.ts
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/packaged-runtime.test.ts
```

- [ ] **Step 6: Implement authority selection and source confidence**

Read credit/proof lists from authorities when present, otherwise from the
receiver adapter. Expose the corresponding confidence map after collection and
pass registry authorities into every release-suite driver.

- [ ] **Step 7: Verify GREEN and update DX docs**

Run the focused tests and document one smoke-only manifest plus one
release-authority manifest.

- [ ] **Step 8: Commit**

```bash
git add apps/lab-cli packages/scenario-runner spec/examples/adapters.local.json docs/adapter-guide.md README.md
git commit -m "feat: accept independent external evidence authorities"
```

### Task 3: Exact fault rule and route evidence

**Files:**
- Modify: `apps/http-fault-gateway/src/control.ts`
- Test: `apps/http-fault-gateway/test/gateway.test.ts`
- Modify: `packages/scenario-runner/src/external-adapter-driver.ts`
- Modify: `packages/scenario-runner/src/external-http-fault-controller.ts`
- Test: `packages/scenario-runner/test/external-http-fault-controller.test.ts`
- Test: `packages/scenario-runner/test/external-adapter-driver.test.ts`

**Interfaces:**
- Produces: `ExternalFaultRuleHandle`
- Produces: `ExternalFaultRuleEvidence`
- Changes: `ExternalFaultController.configure(target, rule, route)` returns the handle.

- [ ] **Step 1: Write failing gateway/controller tests**

Require gateway evidence to contain rule ID, phase, action, safe method/path,
remaining, and applied. Require controller configuration to parse the returned
ID and preserve its exact mapped phase/action/route.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/http-fault-gateway exec vitest run test/gateway.test.ts
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/external-http-fault-controller.test.ts
```

- [ ] **Step 3: Implement safe gateway evidence and handles**

Include only `method` and `path` from a rule match. Never expose
`deliveryIdHash`. Parse the `201 { id }` response under the existing response
size and redirect protections.

- [ ] **Step 4: Write failing unrelated-rule regression test**

Configure two rules, apply only the unrelated one, and require
`External configured fault was not exercised`.

- [ ] **Step 5: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/external-adapter-driver.test.ts
```

- [ ] **Step 6: Implement exact handle matching**

Derive `POST` plus the selected payment request path, store every returned
handle, and require an evidence row matching all handle fields with
`applied > 0`.

- [ ] **Step 7: Verify GREEN and commit**

```bash
git add apps/http-fault-gateway packages/scenario-runner
git commit -m "fix: bind external faults to exact rules and routes"
```

### Task 4: Cryptographic release-suite binding

**Files:**
- Modify: `apps/lab-cli/src/release-suite-loader.ts`
- Test: `apps/lab-cli/test/release-suite-loader.test.ts`
- Modify: `packages/scenario-runner/src/release-policy.ts`
- Test: `packages/scenario-runner/test/release-policy.test.ts`
- Modify: `packages/scenario-runner/src/matrix.ts`
- Test: `packages/scenario-runner/test/matrix.test.ts`
- Modify: `apps/lab-cli/src/index.ts`
- Test: `apps/lab-cli/test/cli.test.ts`
- Modify: `spec/release-policy.json`
- Modify: `spec/schemas/release-policy.schema.json`
- Modify: `packages/adapter-contract/src/schemas.ts`
- Test: `packages/adapter-contract/test/contract.test.ts`

**Interfaces:**
- Produces: `LoadedReleaseSuite.digest`
- Produces: policy schema v3 `releaseSuiteDigest`
- Produces: `MatrixCaseResult.releaseSuiteDigest`
- Produces reason: `RELEASE_SUITE_DIGEST_MISMATCH`.

- [ ] **Step 1: Write failing digest tests**

Use fixed suite/scenario text and assert a deterministic digest. Change scenario
commands, required invariants, scenario bytes, and order independently and
assert each changes the digest. Preserve symlink confinement tests.

- [ ] **Step 2: Verify loader tests RED**

```bash
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/release-suite-loader.test.ts
```

- [ ] **Step 3: Implement length-prefixed bundle hashing**

Use `node:crypto` SHA-256 and raw UTF-8 bytes. Attach the digest to the loaded
suite without weakening file bounds or realpath checks.

- [ ] **Step 4: Write failing policy/CLI tests**

Require schema version 3, exact digest syntax, early CLI rejection of a loaded
suite mismatch, and pair rejection when result evidence carries another digest.

- [ ] **Step 5: Verify policy/CLI tests RED**

```bash
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/release-policy.test.ts test/matrix.test.ts
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/cli.test.ts
```

- [ ] **Step 6: Implement binding and update checked-in digest**

Propagate the loaded digest through matrix execution and validate it both before
adapter startup and inside the policy evaluator. Compute and store the canonical
repository suite digest in `spec/release-policy.json`.

- [ ] **Step 7: Verify GREEN and schemas**

```bash
pnpm --filter @cashu-fault-lab/adapter-contract exec vitest run test/contract.test.ts
pnpm codegen:check
```

- [ ] **Step 8: Commit**

```bash
git add apps/lab-cli packages/scenario-runner packages/adapter-contract spec
git commit -m "feat: bind release policy to the exact scenario suite"
```

### Task 5: Conservative suite invariant aggregation

**Files:**
- Modify: `apps/lab-cli/src/packaged-runtime.ts`
- Test: `apps/lab-cli/test/packaged-runtime.test.ts`
- Modify: `packages/scenario-runner/src/release-policy.ts`
- Test: `packages/scenario-runner/test/release-policy.test.ts`

**Interfaces:**
- Produces: `aggregateReleaseSuiteInvariants(scenarios)`.
- Replaces smoke invariants only when a release suite is active.

- [ ] **Step 1: Write failing aggregation tests**

Cover: smoke failure short-circuits; passing suite replaces a failing stale
smoke invariant; one weak scenario confidence downgrades the aggregate; one
non-passing required scenario invariant makes the aggregate non-passing; and an
invariant absent from every suite entry stays missing.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/packaged-runtime.test.ts
pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/release-policy.test.ts
```

- [ ] **Step 3: Implement deterministic conservative aggregation**

Aggregate only each entry's `requiredInvariants`, rank status and confidence
conservatively, combine evidence deterministically, and return:

```ts
{
  ...smoke,
  invariants: aggregateReleaseSuiteInvariants(scenarios),
  scenarios,
  releaseSuiteDigest: releaseSuite.digest,
}
```

- [ ] **Step 4: Verify GREEN and commit**

```bash
git add apps/lab-cli/src/packaged-runtime.ts apps/lab-cli/test/packaged-runtime.test.ts packages/scenario-runner/src/release-policy.ts packages/scenario-runner/test/release-policy.test.ts
git commit -m "fix: aggregate release suite evidence conservatively"
```

### Task 6: Preview metadata, workflow semantics, and documentation

**Files:**
- Modify: `apps/lab-cli/src/index.ts`
- Modify: `apps/lab-cli/src/packaged-runtime.ts`
- Modify: `packages/scenario-runner/src/reference-capabilities.ts`
- Modify: `packages/scenario-runner/src/reference-probe.ts`
- Test: `apps/lab-cli/test/packaged-runtime.test.ts`
- Modify: `scripts/release-metadata.test.mjs`
- Modify: `docs/examples/v0.1.0-demo.json`
- Modify: `docs/examples/v0.1.0-demo.html`
- Modify: `README.md`
- Modify: `docs/releases/v0.1.0.md`
- Modify: `docs/releases/v0.1.0-checklist.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Repository-owned component version: `0.1.0`.
- Release workflow: manual qualification, never an automatic tag-push release.

- [ ] **Step 1: Write failing metadata tests**

Reject `0.0.0` in checked-in demo JSON/HTML and runtime-owned component
versions. Assert the coverage table no longer lists named cashu-ts crash
boundaries as missing.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/release-metadata.test.mjs
pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/packaged-runtime.test.ts
```

- [ ] **Step 3: Update runtime metadata and regenerate demo artifacts**

Use `0.1.0` in the CLI and reference runtime. Regenerate the deterministic demo
through the packaged command so JSON and HTML describe the same run.

- [ ] **Step 4: Make qualification workflow honest**

Remove the automatic tag trigger. Add an explicit positive policy-engine fixture
to CI and make the repository-only strict command an expected blocked check with
stable rejection output.

- [ ] **Step 5: Update docs**

Explain evidence authorities, suite digest binding, exact rule evidence, current
crash coverage, and the remaining independent-integration blockers.

- [ ] **Step 6: Verify GREEN and commit**

```bash
git add apps/lab-cli packages/scenario-runner scripts docs README.md .github/workflows
git commit -m "docs: align preview artifacts and release qualification"
```

### Task 7: Full end-to-end verification and branch review

**Files:**
- Review all files changed from `origin/main`.

**Interfaces:**
- Consumes every prior task.
- Produces a verified feature branch without publishing it.

- [ ] **Step 1: Run static and generated checks**

```bash
pnpm format:check
pnpm docs:cli:check
pnpm codegen:check
pnpm openapi:validate
pnpm exec turbo run typecheck --force
pnpm exec turbo run build --force
```

- [ ] **Step 2: Run complete local tests without cache**

```bash
pnpm exec turbo run test --force -- --exclude 'test/postgres-state.test.ts' --exclude 'test/postgres-store.test.ts' --exclude 'test/crash-recovery.test.ts' --exclude 'test/postgres-receiver-store.test.ts' --exclude 'test/docker-mint-e2e.test.ts' --exclude 'test/docker-funded-e2e.test.ts' --exclude 'test/nostr-relay-e2e.test.ts' --exclude 'test/cross-language-docker.test.ts'
node --test scripts/test-tiers.test.mjs scripts/docker-context.test.mjs scripts/release-metadata.test.mjs
pnpm test:consumer
pnpm audit --prod
```

- [ ] **Step 3: Run Rust checks**

```bash
cargo fmt --manifest-path adapters/cdk/Cargo.toml --check
cargo clippy --manifest-path adapters/cdk/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path adapters/cdk/Cargo.toml
```

- [ ] **Step 4: Run Docker end-to-end lanes when available**

```bash
docker info
pnpm test:integration
pnpm test:funded
pnpm test:browser
```

If Docker or funded credentials are unavailable, record the exact preflight
result and do not claim those local lanes passed.

- [ ] **Step 5: Exercise both release outcomes**

Run the positive trusted fixture and the bundled strict policy. The fixture must
pass. The bundled repository-only qualification must remain blocked for
documented independent evidence/provenance reasons.

- [ ] **Step 6: Review diff and preserve origin/main safety fixes**

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
```

Confirm settlement remains atomic and the suite loader still rejects symlink
escapes.

- [ ] **Step 7: Final verification commit if required**

Commit only necessary formatting, generated artifacts, or verification fixes.
Do not push or create a PR unless the user asks.

