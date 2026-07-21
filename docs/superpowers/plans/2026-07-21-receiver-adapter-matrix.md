# Receiver Adapter Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `adapters/cashu-ts` a real delivery-v1 receiver so the external matrix can produce non-reference receiver evidence.

**Architecture:** Add funded receiver operations beside the existing funded sender operations, compose both into a dual-role adapter for Docker/local runs, and keep the control API backward-compatible when receiver dependencies are absent. Reuse the reference receiver's domain ports for settlement, proof evidence, and request binding rather than asking upstream Cashu TS for new APIs.

**Tech Stack:** TypeScript, Fastify, `@cashu/cashu-ts`, workspace `@cashu-fault-lab/*` packages, Vitest, Docker Compose.

## Global Constraints

- Branch name must not include `codex`.
- Use TDD: add failing tests before production code.
- Keep receiver support lab-side; escalate upstream only if existing Cashu TS APIs block adapter implementation.
- Do not expose proof secrets or control tokens in adapter evidence.

---

### Task 1: Cashu TS Receiver Operations

**Files:**

- Create: `adapters/cashu-ts/src/funded-receiver-operations.ts`
- Modify: `adapters/cashu-ts/src/index.ts`
- Test: `adapters/cashu-ts/test/funded-receiver-operations.test.ts`

**Interfaces:**

- Produces: `FundedCashuTsReceiverOperations` with `capabilities()`, `reset(seed)`, `createRequest(input)`, `receive(bytes)`, `delivery(id)`, `ledger()`, and `proofs()`.
- Consumes: reference receiver domain ports, `MemoryReceiverStore`, `CashuTsMintGateway`, `CashuTsProofVerifier`.

- [x] Write failing receiver settlement/evidence test.
- [x] Run test and verify missing export/class failure.
- [x] Implement minimal receiver operations.
- [x] Run focused receiver test until green.

### Task 2: Dual-Role Adapter Server

**Files:**

- Modify: `adapters/cashu-ts/src/server.ts`
- Modify: `adapters/cashu-ts/src/funded-server.ts`
- Modify: `adapters/cashu-ts/src/bin.ts`
- Test: `adapters/cashu-ts/test/funded-receiver-operations.test.ts`

**Interfaces:**

- Produces: `FundedCashuTsDualRoleOperations` composed from existing sender operations and new receiver operations.
- Produces: `/pay` route when operations include `receive(bytes)`.
- Keeps existing sender-only behavior when receiver proof claim key is omitted.

- [x] Write failing dual-role server test.
- [x] Run focused test and verify route/capability failure.
- [x] Implement server delegation and `/pay` route.
- [x] Run focused test until green.

### Task 3: Local Matrix Integration

**Files:**

- Modify: `infra/compose/wallet-adapters.compose.yml`
- Modify: `.env.example`
- Test: existing CLI/matrix tests plus Docker matrix smoke.

**Interfaces:**

- Produces: Docker `cashu-ts` service with receiver claim key and payment target.
- External matrix should include real passes using `cashu-ts` as receiver.

- [x] Add compose/env receiver configuration.
- [x] Run adapter package tests.
- [x] Run full TypeScript/Rust checks.
- [x] Run `pnpm lab matrix --profile delivery-v1 --adapters spec/examples/adapters.local.json --verbose` against Docker services.
- [ ] Review diff for security, commit, push, and open draft PR.
