# CLI Foundation and Contract Codegen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first two design-plan PRs in one feature branch: modular CLI commands with generated CLI documentation and diagnostics, plus deterministic adapter-contract code generation and compatibility metadata.

**Architecture:** Keep `runCli()` as the stable public test seam while moving command registration into focused modules backed by a declarative registry. Keep adapter safety wrappers maintained by humans, and generate deterministic TypeScript/Rust/Python contract artifacts from `spec/openapi.yaml` for consumers and drift checks.

**Tech Stack:** TypeScript 7, pnpm 11.15, Turbo 2.10, Vitest 4, Commander 15, AJV 2020-12, OpenAPI 3.1, Node 24.x.

## Global Constraints

- Branch starts from `origin/main` at `a1ee910903b4d8876685d98583289c9023541905`.
- Every production behavior change follows a witnessed red-green test cycle.
- Generated code is committed and deterministic; normal consumers do not need Java or OpenAPI Generator to build.
- Existing HTTP transport protections remain intact: bounded responses, disabled redirects, token redaction, timeouts, validation, and stable error codes.
- Diagnostics include problem, likely cause, remediation, and exact next command.
- Human-readable command output and machine-readable `--json` output remain supported.

---

### Task 1: CLI Registry, Modular Commands, and Documentation

**Files:**

- Create: `apps/lab-cli/src/cli-context.ts`
- Create: `apps/lab-cli/src/command-registry.ts`
- Create: `apps/lab-cli/src/commands/*.ts`
- Create: `scripts/generate-cli-docs.mjs`
- Create: `docs/cli-reference.md`
- Modify: `apps/lab-cli/src/index.ts`
- Modify: `apps/lab-cli/test/cli.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `createCommandRegistry(): readonly CliCommandDefinition[]`
- Produces: `registerCliCommands(program, context): void`
- Produces: `pnpm docs:cli` and `pnpm docs:cli:check`

- [ ] **Step 1: Write failing CLI registry and docs tests**

Add tests that assert registry metadata includes `run`, `doctor`, and `matrix`, and that `docs/cli-reference.md` is generated from the same examples/options.

- [ ] **Step 2: Run focused CLI tests and confirm RED**

Run: `pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/cli.test.ts`

Expected: FAIL because `command-registry.ts` and docs scripts do not exist.

- [ ] **Step 3: Move command registration into modules**

Keep command behavior unchanged, extract shared parsing and IO into `cli-context.ts`, and register commands from registry entries.

- [ ] **Step 4: Generate CLI reference**

Implement `scripts/generate-cli-docs.mjs`, add root scripts, generate `docs/cli-reference.md`, and make `docs:cli:check` fail on drift.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/cli.test.ts`

Expected: PASS.

### Task 2: Shared Diagnostic Catalogue

**Files:**

- Create: `apps/lab-cli/src/diagnostics.ts`
- Modify: `apps/lab-cli/src/doctor.ts`
- Modify: `apps/lab-cli/src/index.ts`
- Modify: `apps/lab-cli/test/doctor.test.ts`
- Modify: `apps/lab-cli/test/cli.test.ts`

**Interfaces:**

- Produces: `LabDiagnosticError`
- Produces: `createDiagnostic(code, detailOverrides)`
- Produces: `renderDiagnosticText(error)` and `renderDiagnosticJson(error)`

- [ ] **Step 1: Write failing diagnostic tests**

Add tests for `NODE_VERSION_UNSUPPORTED`, `DOCKER_DAEMON_UNAVAILABLE`, `PORT_IN_USE`, and command-level JSON errors.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/doctor.test.ts test/cli.test.ts`

Expected: FAIL because diagnostics are still ad hoc.

- [ ] **Step 3: Implement catalogue and renderers**

Create the initial diagnostic catalogue requested in the design plan. Convert doctor checks to optionally carry diagnostic codes and render complete remediation fields in `doctor --json`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @cashu-fault-lab/lab-cli exec vitest run test/doctor.test.ts test/cli.test.ts`

Expected: PASS.

### Task 3: Deterministic Contract Codegen

**Files:**

- Create: `spec/codegen/openapi-generator.version`
- Create: `spec/codegen/config.{typescript,rust,python}.json`
- Create: `spec/codegen/batch.yaml`
- Create: `packages/adapter-contract/src/generated/typescript/*`
- Create: `packages/adapter-contract/generated/rust/*`
- Create: `packages/adapter-contract/generated/python/*`
- Create: `scripts/codegen.mjs`
- Create: `scripts/validate-openapi.mjs`
- Modify: `packages/adapter-contract/src/index.ts`
- Modify: `packages/adapter-contract/test/contract.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `pnpm codegen`
- Produces: `pnpm codegen:check`
- Produces: `pnpm openapi:validate`

- [ ] **Step 1: Write failing codegen drift tests**

Add tests that import the generated TypeScript models and assert core generated types match the current exported hand-maintained types.

- [ ] **Step 2: Run adapter-contract tests and confirm RED**

Run: `pnpm --filter @cashu-fault-lab/adapter-contract exec vitest run test/contract.test.ts`

Expected: FAIL because generated artifacts do not exist.

- [ ] **Step 3: Implement deterministic local generator wrapper**

Use the pinned generator metadata and checked-in configs. The wrapper must regenerate artifacts to a temporary directory for `--check` and compare the result to committed output.

- [ ] **Step 4: Validate OpenAPI**

Implement a lightweight OpenAPI structural validator that checks version, paths, operation IDs, schema refs, and contract/schema alignment without adding a runtime Java dependency.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm codegen:check && pnpm openapi:validate && pnpm --filter @cashu-fault-lab/adapter-contract exec vitest run test/contract.test.ts`

Expected: PASS.

### Task 4: Compatibility Metadata

**Files:**

- Modify: `spec/openapi.yaml`
- Modify: `spec/schemas/adapter-capabilities.schema.json`
- Modify: `packages/adapter-contract/src/types.ts`
- Modify: `packages/adapter-contract/src/validation.ts`
- Modify: `packages/scenario-runner/src/matrix.ts`
- Modify: `packages/scenario-runner/src/external-pair.ts`
- Modify: `packages/report/src/matrix.ts`
- Modify: capability fixtures across `apps/`, `adapters/`, and tests.

**Interfaces:**

- Produces: `contract: { apiVersion: 1, schemaVersion: 2, specDigest: "sha256:..." }`
- Produces: compatibility warnings for missing legacy metadata
- Produces: pre-scenario rejection for unsupported API version or digest mismatch

- [ ] **Step 1: Write failing compatibility tests**

Add tests for missing metadata warning, unsupported `apiVersion` rejection, digest mismatch rejection, and matrix/report inclusion.

- [ ] **Step 2: Run focused contract and scenario tests and confirm RED**

Run: `pnpm --filter @cashu-fault-lab/adapter-contract exec vitest run test/contract.test.ts && pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/external-pair.test.ts test/matrix.test.ts`

Expected: FAIL because metadata is not part of the schema or runner.

- [ ] **Step 3: Implement schema/type/digest support**

Compute the spec digest from canonical `spec/openapi.yaml` bytes. Require supported `apiVersion`, accept missing metadata with a warning, and explain digest mismatch with a regeneration-oriented diagnostic.

- [ ] **Step 4: Include compatibility in reports**

Expose compatibility data in matrix JSON/JUnit/HTML report inputs without leaking secrets.

- [ ] **Step 5: Verify GREEN**

Run the focused contract, scenario-runner, report, CLI docs, typecheck, and unit tests before final summary.
