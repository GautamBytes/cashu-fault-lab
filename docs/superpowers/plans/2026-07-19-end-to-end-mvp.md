# Cashu Fault Lab End-to-End MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build runnable Cashu payment-delivery fault lab proving repeated HTTP/NIP-17 delivery causes at most one receiver settlement and one merchant credit, including response loss, crash recovery, replay, and cross-implementation evidence.

**Architecture:** Keep wire/profile code pure. Put systems under test behind language-neutral HTTP adapters. Reference sender and receiver share no persistence with independent oracle. Receiver uses PostgreSQL inbox/reservation/swap-plan/outbox transactions; runner controls virtual time and semantic fault services; real mint behavior enters through a narrow gateway.

**Tech Stack:** Node.js 24, pnpm 11.15.0, TypeScript 7.0.2, Vitest 4.1.10, fast-check 4.9.0, Ajv 8.20.0, Fastify 5.10.0, @fastify/cors 11.3.0, Kysely 0.29.4, pg 8.22.0, cashu-ts 4.7.2, nostr-tools 2.23.12, Testcontainers 12.0.4, PostgreSQL 17, Rust 1.97, CDK 0.17.3.

## Global Constraints

- Cashu NUT baseline pinned to `fccb68e9129de5348003f573dc97e1ee380a1076`.
- Nostr NIP baseline pinned to `bdfa7e62ef87fcfcb992b1a27aee49d36b0b4f91`.
- NUT-18 NIP-17 mapping is normative for lab; current NUT-26 NIP-04/raw-key mismatch is tested as upstream incompatibility, not silently normalized.
- At-least-once transport plus idempotent processing; never claim exactly-once transport.
- Receiver credits only after its own successful or NUT-09-recovered NUT-03 swap outputs.
- Same logical retry reuses request ID, delivery ID, exact inner payload, proofs, and swap outputs.
- Raw proof secrets, signatures, witnesses, blinded output material, complete payloads, and encryption keys never enter logs/reports.
- Independent oracle never imports delivery-core, receiver state machine, receiver persistence, cashu-ts, or CDK.
- Every behavior change follows red-green-refactor. Every task ends green and committed.
- Runtime dependencies pinned exactly. Generated artifacts ignored.

---

### Task 1: Protocol Lock and Core Invariant Repairs

**Files:**

- Create: `spec/upstream-lock.json`
- Modify: `packages/delivery-core/test/fingerprint.test.ts`
- Modify: `packages/delivery-core/test/receipt.test.ts`
- Modify: `packages/delivery-core/src/fingerprint.ts`
- Modify: `packages/delivery-core/src/receipt.ts`

**Interfaces:**

- Produces: sparse-array-safe JSON validation; initial receiver receipt version invariant; reproducible upstream commit lock.

- [x] **Step 1: Add failing sparse-array and initial-version tests**

```ts
it('rejects a sparse proof array', () => {
  expect(() => computePayloadHash(payloadInput({ proofs: Array(1) }))).toThrowError(
    DeliveryValidationError,
  );
});

it('requires the first receiver receipt to start at version one', () => {
  expect(() => assertReceiptTransition(undefined, receipt({ statusVersion: 2 }))).toThrowError(
    /start at version 1/i,
  );
});
```

- [x] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- fingerprint.test.ts receipt.test.ts`

Expected: both new tests fail because array holes are skipped and any positive initial version is accepted.

- [x] **Step 3: Implement indexed array validation and initial version check**

```ts
function assertDenseArray(value: readonly unknown[], path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalidFingerprint(`${path} must not contain holes`);
  }
}

if (!previous) {
  if (next.statusVersion !== 1) {
    throw new DeliveryValidationError('STATUS_VERSION_CONFLICT', 'Receipt must start at version 1');
  }
  return;
}
```

- [x] **Step 4: Add upstream lock**

```json
{
  "checked_at": "2026-07-19",
  "cashu_nuts": {
    "repository": "https://github.com/cashubtc/nuts",
    "ref": "fccb68e9129de5348003f573dc97e1ee380a1076"
  },
  "nostr_nips": {
    "repository": "https://github.com/nostr-protocol/nips",
    "ref": "bdfa7e62ef87fcfcb992b1a27aee49d36b0b4f91"
  }
}
```

- [x] **Step 5: Run delivery-core gate**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test && pnpm --filter @cashu-fault-lab/delivery-core typecheck && pnpm --filter @cashu-fault-lab/delivery-core build`

Expected: all pass.

- [x] **Step 6: Commit**

```bash
git add spec/upstream-lock.json packages/delivery-core
git commit -m "fix: close delivery core invariant gaps"
```

### Task 2: Delivery Request, Payload, Amount, Expiry, and Duplicate Semantics

**Files:**

- Create: `packages/delivery-core/src/request.ts`
- Create: `packages/delivery-core/src/payload.ts`
- Create: `packages/delivery-core/src/amount.ts`
- Create: `packages/delivery-core/src/duplicate.ts`
- Create: `packages/delivery-core/test/request.test.ts`
- Create: `packages/delivery-core/test/payload.test.ts`
- Create: `packages/delivery-core/test/amount.test.ts`
- Create: `packages/delivery-core/test/duplicate.test.ts`
- Modify: `packages/delivery-core/src/index.ts`
- Modify: `packages/delivery-core/src/errors.ts`

**Interfaces:**

- Produces: `parseDeliveryNegotiation(tags, now)`, `parseDeliveryPayload(value, now)`, `computeNetAmount(proofs, keysets)`, `classifyDelivery(previous, incoming)`.

- [x] **Step 1: Write failing request-negotiation tests**

```ts
expect(
  parseDeliveryNegotiation(
    [
      ['delivery', '1'],
      ['expires_at', '1784400300'],
    ],
    1784399400,
  ),
).toEqual({
  version: 1,
  expiresAt: 1784400300,
});
expect(parseDeliveryNegotiation([['delivery', '2']], 1)).toBeUndefined();
expect(() =>
  parseDeliveryNegotiation(
    [
      ['delivery', '1'],
      ['expires_at', '90002'],
    ],
    1,
  ),
).toThrowError(/24 hours/i);
```

- [x] **Step 2: Write failing payload boundary tests**

```ts
expect(parseDeliveryPayload(validWirePayload(), now)).toMatchObject({ delivery: { version: 1 } });
expect(() => parseDeliveryPayload(oversizedWirePayload(65_537), now)).toThrowError(/65,536/i);
expect(() =>
  parseDeliveryPayload(validWirePayload({ delivery: { expires_at: now - 61 } }), now),
).toThrowError(/expired/i);
```

- [x] **Step 3: Write failing amount and duplicate tests**

```ts
expect(computeNetAmount([{ amount: 8, id: '00aa' }], new Map([['00aa', 1_000]]))).toBe(7);
expect(assertExactRequestedAmount(7, 7)).toBeUndefined();
expect(classifyDelivery(stored, { ...stored })).toBe('duplicate');
expect(classifyDelivery(stored, { ...stored, payloadHash: 'b'.repeat(64) })).toBe(
  'delivery_conflict',
);
expect(classifyDelivery(stored, { ...stored, deliveryId: otherId })).toBe('proof_conflict');
```

- [x] **Step 4: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test -- request.test.ts payload.test.ts amount.test.ts duplicate.test.ts`

Expected: modules/exports missing.

- [x] **Step 5: Implement exact public models**

```ts
export interface DeliveryNegotiation {
  readonly version: 1;
  readonly expiresAt: number;
}
export interface DeliveryPayload {
  readonly id: ProtocolId;
  readonly memo: string | null;
  readonly mint: string;
  readonly unit: string;
  readonly proofs: readonly CashuProof[];
  readonly delivery: {
    readonly version: 1;
    readonly id: ProtocolId;
    readonly createdAt: number;
    readonly expiresAt: number;
  };
}
export type DeliveryClassification =
  'new' | 'duplicate' | 'delivery_conflict' | 'proof_conflict' | 'single_use_conflict';
```

Implementation requirements: own-property-safe wire parsing, snake_case codec, 60-second expiry skew, exact 65,536-byte UTF-8 JSON limit, 256 proofs, safe integer sums, NUT-02 fee `(sum(input_fee_ppk) + 999) // 1000`, exact requested net amount.

- [x] **Step 6: Run full core tests and build**

Run: `pnpm --filter @cashu-fault-lab/delivery-core test && pnpm --filter @cashu-fault-lab/delivery-core typecheck && pnpm --filter @cashu-fault-lab/delivery-core build && pnpm --filter @cashu-fault-lab/delivery-core test:consumer`

Expected: all pass.

- [x] **Step 7: Commit**

```bash
git add packages/delivery-core
git commit -m "feat: complete delivery profile semantics"
```

### Task 3: Normative Schemas, Vectors, and Adapter Contract

**Files:**

- Create: `spec/delivery-v1.md`
- Create: `spec/invariants.md`
- Create: `spec/threat-model.md`
- Create: `spec/schemas/delivery-request.schema.json`
- Create: `spec/schemas/delivery-payload.schema.json`
- Create: `spec/schemas/delivery-receipt.schema.json`
- Create: `spec/schemas/adapter-capabilities.schema.json`
- Create: `spec/schemas/scenario-result.schema.json`
- Create: `spec/vectors/delivery-v1-wire.json`
- Create: `spec/vectors/delivery-v1-invalid.json`
- Create: `packages/adapter-contract/package.json`
- Create: `packages/adapter-contract/src/index.ts`
- Create: `packages/adapter-contract/src/schemas.ts`
- Create: `packages/adapter-contract/src/types.ts`
- Create: `packages/adapter-contract/test/contract.test.ts`

**Interfaces:**

- Produces: versioned JSON Schema 2020-12 artifacts; `validateAdapterRequest`; `validateAdapterResponse`; adapter endpoint types.

- [x] **Step 1: Add package and failing schema/vector tests**

```ts
it.each(validVectors)('accepts $name', ({ payload }) => {
  expect(validateDeliveryPayload(payload)).toEqual({ ok: true });
});
it.each(invalidVectors)('rejects $name with stable code', ({ payload, error_code }) => {
  expect(validateDeliveryPayload(payload)).toMatchObject({ ok: false, errorCode: error_code });
});
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/adapter-contract test`

Expected: package/schema APIs missing.

- [x] **Step 3: Implement schemas and contract types**

```ts
export interface AdapterCapabilities {
  readonly implementation: string;
  readonly version: string;
  readonly nuts: readonly number[];
  readonly transports: readonly ('http' | 'nostr')[];
  readonly evidenceTier: 'T0' | 'T1' | 'T2' | 'T3';
}

export interface AdapterClient {
  capabilities(): Promise<AdapterCapabilities>;
  reset(seed: string): Promise<void>;
  createRequest(input: CreateRequestInput): Promise<PaymentRequestView>;
  send(input: SendPaymentInput): Promise<DeliveryReceiptView>;
  delivery(deliveryId: string): Promise<DeliveryReceiptView>;
  ledger(): Promise<readonly LedgerCreditView[]>;
  proofs(): Promise<readonly ProofEvidenceView[]>;
}
```

Normative adapter HTTP routes: `GET /v1/capabilities`, `POST /v1/reset`, `POST /v1/requests`, `POST /v1/send`, `GET /v1/deliveries/:id`, `GET /v1/ledger`, `GET /v1/proofs`.

- [x] **Step 4: Cross-check schemas against TypeScript codecs**

Run: `pnpm --filter @cashu-fault-lab/adapter-contract test && pnpm --filter @cashu-fault-lab/delivery-core test`

Expected: every valid vector accepted by schema and codec; every invalid vector rejected with matching stable code.

- [x] **Step 5: Commit**

```bash
git add spec packages/adapter-contract
git commit -m "feat: publish delivery schemas and adapter contract"
```

### Task 4: Independent Sequential Oracle

**Files:**

- Create: `packages/oracle/package.json`
- Create: `packages/oracle/src/model.ts`
- Create: `packages/oracle/src/commands.ts`
- Create: `packages/oracle/src/invariants.ts`
- Create: `packages/oracle/src/index.ts`
- Create: `packages/oracle/test/model.test.ts`
- Create: `packages/oracle/test/property.test.ts`

**Interfaces:**

- Consumes: adapter observation DTOs only.
- Produces: `OracleModel`, `applyObservation(model, observation)`, `assertSafety(model)`, `assertQuiescentLiveness(model)`.

- [x] **Step 1: Write failing example and fast-check properties**

```ts
fc.assert(
  fc.property(deliveryHistoryArbitrary(), (history) => {
    const model = history.reduce(applyObservation, emptyOracleModel());
    expect(() => assertSafety(model)).not.toThrow();
  }),
);

expect(() => assertSafety(modelWithTwoCreditsForOneDelivery())).toThrowError(/one credit/i);
expect(() => assertSafety(modelWithTwoOwnersForOneProof())).toThrowError(/unique owner/i);
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/oracle test`

Expected: package missing.

- [x] **Step 3: Implement independent model**

```ts
export interface OracleModel {
  readonly requests: ReadonlyMap<string, OracleRequest>;
  readonly deliveries: ReadonlyMap<string, OracleDelivery>;
  readonly proofOwners: ReadonlyMap<string, string>;
  readonly credits: ReadonlyMap<string, OracleCredit>;
  readonly receipts: ReadonlyMap<string, OracleReceipt>;
}

export type Observation =
  | { type: 'delivery_attempted'; deliveryId: string; payloadHash: string; proofSetHash: string }
  | { type: 'mint_proofs_state'; proofSetHash: string; state: 'UNSPENT' | 'PENDING' | 'SPENT' }
  | { type: 'receiver_settled'; deliveryId: string; replacementPlanHash: string }
  | { type: 'merchant_credited'; deliveryId: string; amount: number }
  | { type: 'receipt_observed'; deliveryId: string; status: string; version: number };
```

Safety invariants: unique proof owner; max one settlement plan per delivery; max one credit per delivery/request reservation; terminal receipt implies own recovered outputs plus one credit; duplicates cannot alter value/ledger; cross-transport same delivery has one effect. Oracle source must have zero imports from `@cashu-fault-lab/delivery-core`.

- [x] **Step 4: Run property tests with 1,000 cases**

Run: `pnpm --filter @cashu-fault-lab/oracle test`

Expected: pass with fixed seed logged only on failure.

- [x] **Step 5: Commit**

```bash
git add packages/oracle
git commit -m "feat: add independent payment safety oracle"
```

### Task 5: Deterministic Scheduler and Scenario Runner

**Files:**

- Create: `packages/scenario-runner/package.json`
- Create: `packages/scenario-runner/src/scheduler.ts`
- Create: `packages/scenario-runner/src/history.ts`
- Create: `packages/scenario-runner/src/runner.ts`
- Create: `packages/scenario-runner/src/replay.ts`
- Create: `packages/scenario-runner/src/index.ts`
- Create: `packages/scenario-runner/test/scheduler.test.ts`
- Create: `packages/scenario-runner/test/runner.test.ts`
- Create: `packages/scenario-runner/test/replay.test.ts`

**Interfaces:**

- Consumes: `AdapterClient`, fault-controller clients, oracle observation sink.
- Produces: deterministic `ScenarioRunner.run(spec, seed)`, serialized `FailureArtifact`, exact replay.

- [x] **Step 1: Write failing scheduler/replay tests**

```ts
const scheduler = new VirtualScheduler(0);
scheduler.schedule(250, () => events.push('retry'));
scheduler.advanceBy(249);
expect(events).toEqual([]);
scheduler.advanceBy(1);
expect(events).toEqual(['retry']);

const first = await runner.run(scenario, 'seed-1');
expect(await runner.replay(first.artifact)).toEqual(first);
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/scenario-runner test`

Expected: package missing.

- [x] **Step 3: Implement command/history model**

```ts
export type ScenarioCommand =
  | { type: 'configure_fault'; target: 'http' | 'nostr' | 'receiver' | 'mint'; rule: FaultRule }
  | { type: 'send'; sender: string; requestId: string }
  | { type: 'restart'; component: string }
  | { type: 'advance_time'; milliseconds: number }
  | { type: 'clear_faults'; target?: string }
  | { type: 'assert_quiescent' };

export interface FailureArtifact {
  readonly schemaVersion: 1;
  readonly seed: string;
  readonly scenario: string;
  readonly commands: readonly ScenarioCommand[];
  readonly history: readonly HistoryEvent[];
  readonly capabilities: Readonly<Record<string, unknown>>;
}
```

Runner records invocation/completion pairs, passes every observation to oracle, redacts secrets at event creation, shrinks command histories with bounded deterministic delta debugging, and never uses wall-clock sleeps.

- [x] **Step 4: Run runner/oracle tests**

Run: `pnpm --filter @cashu-fault-lab/scenario-runner test && pnpm --filter @cashu-fault-lab/oracle test`

Expected: deterministic replay passes.

- [x] **Step 5: Commit**

```bash
git add packages/scenario-runner
git commit -m "feat: add deterministic fault scenario runner"
```

### Task 6: Reference Receiver Domain and In-Memory Vertical Slice

**Files:**

- Create: `apps/reference-receiver/package.json`
- Create: `apps/reference-receiver/src/domain/types.ts`
- Create: `apps/reference-receiver/src/domain/accept-delivery.ts`
- Create: `apps/reference-receiver/src/domain/recover-delivery.ts`
- Create: `apps/reference-receiver/src/ports/receiver-store.ts`
- Create: `apps/reference-receiver/src/ports/mint-gateway.ts`
- Create: `apps/reference-receiver/src/ports/proof-verifier.ts`
- Create: `apps/reference-receiver/src/adapters/memory-store.ts`
- Create: `apps/reference-receiver/test/accept-delivery.test.ts`
- Create: `apps/reference-receiver/test/concurrency.test.ts`

**Interfaces:**

- Consumes: delivery-core payload/receipt/classification APIs.
- Produces: `acceptDelivery(command, deps)`; transaction-shaped `ReceiverStore`; `MintGateway`.

- [x] **Step 1: Write failing idempotency/conflict/concurrency tests**

```ts
const results = await Promise.all(Array.from({ length: 100 }, () => acceptDelivery(command, deps)));
expect(new Set(results.map((result) => result.deliveryId))).toEqual(new Set([command.deliveryId]));
expect(store.settlementPlans()).toHaveLength(1);
expect(store.credits()).toHaveLength(1);

await expect(acceptDelivery({ ...command, payloadHash: otherHash }, deps)).rejects.toMatchObject({
  code: 'DELIVERY_CONFLICT',
});
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/reference-receiver test`

Expected: app missing.

- [x] **Step 3: Implement explicit receiver ports**

```ts
export interface ReceiverStore {
  createRequest(input: CreatePaymentRequest): Promise<PaymentRequestRecord>;
  prepare(input: PrepareDelivery): Promise<PrepareResult>;
  markMintSent(deliveryId: string): Promise<void>;
  settle(input: CommitSettlement): Promise<DeliveryReceipt>;
  blockRecovery(input: RecoveryBlocked): Promise<DeliveryReceipt>;
  reject(input: RejectDelivery): Promise<DeliveryReceipt>;
  current(deliveryId: string): Promise<DeliveryRecord | undefined>;
}

export interface ProofVerifier {
  inspect(input: InspectProofs): Promise<{
    readonly ys: readonly string[];
    readonly proofSetHash: string;
    readonly netAmount: number;
  }>;
}

export interface MintGateway {
  info(mint: string): Promise<MintCapabilities>;
  swap(plan: ExactSwapPlan): Promise<SwapResult>;
  restore(mint: string, outputs: readonly BlindedOutput[]): Promise<RestoreResult>;
  proofStates(mint: string, ys: readonly string[]): Promise<readonly ProofState[]>;
}
```

`prepare` atomically claims delivery ID, proof-set hash, every proof-Y HMAC, and single-use request reservation. It persists immutable payload binding and exact encrypted swap plan before mint call. `settle` atomically stores recovered result, inserts unique credit, advances receipt, and enqueues outbox row.

- [x] **Step 4: Implement in-memory transactional adapter**

Use one async mutex around state clone/validate/commit. Enforce same unique constraints planned for PostgreSQL. Injected mint fake records exact swap plan and supports success, spent, pending, timeout-before-commit, timeout-after-commit, and restore.

- [x] **Step 5: Run receiver tests**

Run: `pnpm --filter @cashu-fault-lab/reference-receiver test`

Expected: 100 duplicates → one swap plan, one credit, same terminal receipt.

- [x] **Step 6: Commit**

```bash
git add apps/reference-receiver
git commit -m "feat: add idempotent receiver domain"
```

### Task 7: PostgreSQL Receiver Persistence and Crash Recovery

**Files:**

- Create: `infra/migrations/001_receiver.sql`
- Create: `infra/compose/postgres.compose.yml`
- Create: `apps/reference-receiver/src/adapters/postgres-store.ts`
- Create: `apps/reference-receiver/src/adapters/crypto-envelope.ts`
- Create: `apps/reference-receiver/src/worker.ts`
- Create: `apps/reference-receiver/src/outbox-publisher.ts`
- Create: `apps/reference-receiver/test/postgres-store.test.ts`
- Create: `apps/reference-receiver/test/crash-recovery.test.ts`

**Interfaces:**

- Produces: PostgreSQL implementation of `ReceiverStore`; restart-safe recovery worker; encrypted swap-plan persistence.

- [x] **Step 1: Write failing migration/store tests**

```ts
await Promise.all(Array.from({ length: 100 }, () => store.prepare(input)));
expect(await countRows(db, 'deliveries')).toBe(1);
expect(await countRows(db, 'proof_claims')).toBe(input.proofYHmacs.length);

await store.settle(commit);
expect(await countRows(db, 'merchant_credits')).toBe(1);
expect(await countRows(db, 'receipt_outbox')).toBe(1);
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/reference-receiver test -- postgres-store.test.ts`

Expected: migration/store missing.

- [x] **Step 3: Implement schema and constraints**

```sql
CREATE TABLE payment_requests (
  request_id text PRIMARY KEY,
  amount bigint NOT NULL CHECK (amount >= 0),
  unit text NOT NULL,
  single_use boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deliveries (
  delivery_id text PRIMARY KEY,
  request_id text NOT NULL,
  payload_hash char(64) NOT NULL,
  proof_set_hash char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('PREPARED','MINT_SENT','RECOVERY','SETTLED','REJECTED')),
  status_version integer NOT NULL CHECK (status_version >= 1),
  swap_plan_ciphertext bytea NOT NULL,
  swap_plan_nonce bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_single_use_delivery ON deliveries (request_id) WHERE status <> 'REJECTED';
CREATE TABLE proof_claims (
  tenant_id text NOT NULL,
  mint text NOT NULL,
  unit text NOT NULL,
  proof_y_hmac char(64) NOT NULL,
  delivery_id text NOT NULL REFERENCES deliveries(delivery_id),
  PRIMARY KEY (tenant_id, mint, unit, proof_y_hmac)
);
CREATE TABLE merchant_credits (
  delivery_id text PRIMARY KEY REFERENCES deliveries(delivery_id),
  amount bigint NOT NULL CHECK (amount >= 0)
);
CREATE TABLE receipt_outbox (
  id bigserial PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES deliveries(delivery_id),
  status_version integer NOT NULL,
  body jsonb NOT NULL,
  published_at timestamptz,
  UNIQUE (delivery_id, status_version)
);
```

- [x] **Step 4: Implement transactions and recovery scan**

Use `SERIALIZABLE` transaction plus unique-violation re-read for prepare races. Lock delivery row `FOR UPDATE` on mutation. AES-256-GCM envelope uses dedicated 32-byte key; authenticated data binds delivery/request/payload hashes. Worker scans `MINT_SENT`/`RECOVERY`, checks NUT-19 replay capability, NUT-09 restore, then NUT-07 evidence; never credits from `SPENT` alone. Outbox publisher claims rows with `FOR UPDATE SKIP LOCKED`, publishes at least once, then marks `published_at`; duplicate publication remains safe.

- [x] **Step 5: Run PostgreSQL and restart tests**

Run: `pnpm --filter @cashu-fault-lab/reference-receiver test -- postgres-store.test.ts crash-recovery.test.ts`

Expected: restart after mint commit recovers same outputs and creates one credit.

- [x] **Step 6: Commit**

```bash
git add infra/migrations infra/compose apps/reference-receiver
git commit -m "feat: persist crash-safe receiver settlement"
```

### Task 8: Reference Sender, Proof Reservation, and Retry Policy

**Files:**

- Create: `apps/reference-sender/package.json`
- Create: `apps/reference-sender/src/ports/wallet.ts`
- Create: `apps/reference-sender/src/ports/transport.ts`
- Create: `apps/reference-sender/src/send-payment.ts`
- Create: `apps/reference-sender/src/retry.ts`
- Create: `apps/reference-sender/src/state.ts`
- Create: `apps/reference-sender/test/send-payment.test.ts`
- Create: `apps/reference-sender/test/retry.test.ts`

**Interfaces:**

- Produces: stable logical delivery creation; proof reservation; exponential full-jitter retry; receipt merge.

- [x] **Step 1: Write failing sender tests**

```ts
const outcome = await sender.send(request, { seed: 'retry-seed' });
expect(transport.payloads).toHaveLength(3);
expect(new Set(transport.payloads.map(stableJson))).toHaveSize(1);
expect(wallet.createdProofSets).toBe(1);
expect(wallet.reservation(outcome.deliveryId)).toBe('released-settled');

expect(retryDelay({ attempt: 0, random: () => 1 })).toBe(250);
expect(retryDelay({ attempt: 20, random: () => 1 })).toBe(30_000);
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/reference-sender test`

Expected: app missing.

- [x] **Step 3: Implement sender ports and state**

```ts
export interface SenderWallet {
  reserveExact(input: ReservePayment): Promise<ReservedProofSet>;
  markSettled(deliveryId: string): Promise<void>;
  releaseRejected(deliveryId: string): Promise<void>;
  markRecoveryRequired(deliveryId: string): Promise<void>;
}

export interface PaymentTransport {
  send(payload: Uint8Array, target: TransportTarget, signal: AbortSignal): Promise<TransportResult>;
}
```

HTTP `200/202/409/410/413/422` parse receipts. `429/5xx` and timeout retry same bytes. Redirects disabled. Sender never releases proof reservation for unknown outcome or `processing/recovery_blocked`. Transport fallback preserves inner bytes and delivery ID.

- [x] **Step 4: Run sender tests**

Run: `pnpm --filter @cashu-fault-lab/reference-sender test`

Expected: stable-payload and reservation properties pass.

- [x] **Step 5: Commit**

```bash
git add apps/reference-sender
git commit -m "feat: add retry-safe reference sender"
```

### Task 9: HTTP Services and Adapter APIs

**Files:**

- Create: `apps/reference-receiver/src/http/server.ts`
- Create: `apps/reference-receiver/src/http/payment-route.ts`
- Create: `apps/reference-receiver/src/http/adapter-routes.ts`
- Create: `apps/reference-sender/src/http/adapter-server.ts`
- Create: `apps/reference-receiver/test/http.test.ts`
- Create: `apps/reference-sender/test/adapter.test.ts`
- Modify: `apps/reference-receiver/package.json`
- Modify: `apps/reference-sender/package.json`

**Interfaces:**

- Produces: NUT-18 POST receiver; all `/v1` adapter control routes; CORS/size/redirect security policy.

- [x] **Step 1: Write failing HTTP status/idempotency tests**

```ts
expect((await app.inject({ method: 'POST', url: '/pay', payload })).statusCode).toBe(200);
expect((await app.inject({ method: 'POST', url: '/pay', payload })).json()).toEqual(firstReceipt);
expect((await app.inject({ method: 'POST', url: '/pay', payload: conflict })).statusCode).toBe(409);
expect((await app.inject({ method: 'POST', url: '/pay', payload: oversized })).statusCode).toBe(
  413,
);
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/reference-receiver test -- http.test.ts`

Expected: HTTP server missing.

- [x] **Step 3: Implement Fastify services**

Payment route requires `application/json`, byte-counts body before parse, disables framework logging of bodies, maps stable domain errors to `409/410/413/422`, returns `202` plus `Retry-After` while processing. CORS allows configured exact origins, `POST/OPTIONS`, `Content-Type`; no wildcard with credentials. Adapter routes bind loopback by default and require bearer test-control token outside test process.

- [x] **Step 4: Run service/contract tests**

Run: `pnpm --filter @cashu-fault-lab/reference-receiver test && pnpm --filter @cashu-fault-lab/reference-sender test && pnpm --filter @cashu-fault-lab/adapter-contract test`

Expected: all routes conform to schemas.

- [x] **Step 5: Commit**

```bash
git add apps/reference-receiver apps/reference-sender
git commit -m "feat: expose HTTP payment and adapter services"
```

### Task 10: Semantic HTTP Fault Gateway and End-to-End HTTP Scenario

**Files:**

- Create: `apps/http-fault-gateway/package.json`
- Create: `apps/http-fault-gateway/src/rules.ts`
- Create: `apps/http-fault-gateway/src/proxy.ts`
- Create: `apps/http-fault-gateway/src/control.ts`
- Create: `apps/http-fault-gateway/test/gateway.test.ts`
- Create: `scenarios/retry/response-lost.json`
- Create: `scenarios/retry/request-lost.json`
- Create: `scenarios/concurrency/duplicate-storm.json`
- Create: `packages/scenario-runner/test/http-e2e.test.ts`

**Interfaces:**

- Produces: message-aware forward/drop/delay/duplicate/reorder/status injection; first complete HTTP proof.

- [x] **Step 1: Write failing semantic-fault tests**

```ts
gateway.setRule({ phase: 'after_downstream_response', action: 'drop', count: 1 });
await expect(client.post(payload)).rejects.toThrowError(/socket|timeout/i);
expect(receiver.acceptedCount).toBe(1);

const result = await runner.run(responseLostScenario, 'http-response-lost-1');
expect(result.oracle.credits).toHaveLength(1);
expect(result.oracle.settlements).toHaveLength(1);
expect(result.finalReceipt.status).toBe('settled');
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/http-fault-gateway test && pnpm --filter @cashu-fault-lab/scenario-runner test -- http-e2e.test.ts`

Expected: gateway/scenarios missing.

- [x] **Step 3: Implement gateway**

Rules match method, path, delivery ID hash, attempt ordinal, and phase (`before_forward`, `after_downstream_commit`, `after_downstream_response`). Gateway streams no proof-bearing body to logs; control API exposes counters and rule IDs only. Drop-after-response destroys upstream socket after downstream fully completes.

- [x] **Step 4: Run three HTTP scenarios**

Run: `pnpm --filter @cashu-fault-lab/scenario-runner test -- http-e2e.test.ts`

Expected: request loss settles once after retry; response loss returns stored receipt after retry; 100 duplicates produce one credit.

- [x] **Step 5: Commit**

```bash
git add apps/http-fault-gateway scenarios packages/scenario-runner
git commit -m "feat: prove HTTP retry idempotency under faults"
```

### Task 11: Real Mint Gateway, NUT-03 Settlement, NUT-09/19 Recovery

**Files:**

- Create: `apps/reference-receiver/src/adapters/cashu-ts-mint.ts`
- Create: `apps/reference-receiver/src/adapters/swap-plan.ts`
- Create: `apps/reference-receiver/src/adapters/cashu-ts-proof-verifier.ts`
- Create: `apps/reference-sender/src/adapters/cashu-ts-wallet.ts`
- Create: `apps/reference-receiver/test/real-mint.test.ts`
- Create: `apps/reference-receiver/test/nut09-recovery.test.ts`
- Create: `apps/reference-receiver/test/nut19-replay.test.ts`
- Create: `infra/compose/mint.compose.yml`
- Create: `infra/compose/nutshell.compose.yml`
- Create: `infra/compose/cdk-mint.compose.yml`
- Create: `infra/compose/lab.compose.yml`

**Interfaces:**

- Produces: cashu-ts 4.7.2-backed `MintGateway`; exact NUT-03 request replay; capability-conditioned NUT-09/19 recovery; real-mint CI lane.

- [x] **Step 1: Write failing exact-swap and recovery tests**

```ts
const firstBytes = gateway.serializedSwapRequests[0];
mint.commitThenDropResponse();
await expect(receiver.acceptDelivery(command)).resolves.toMatchObject({ status: 'processing' });
await receiver.recover(command.deliveryId);
expect(gateway.serializedSwapRequests[1]).toEqual(firstBytes);
expect((await store.current(command.deliveryId))?.receipt.status).toBe('settled');
expect(await store.creditCount(command.deliveryId)).toBe(1);
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/reference-receiver test -- real-mint.test.ts nut09-recovery.test.ts nut19-replay.test.ts`

Expected: real gateway/infra missing.

- [x] **Step 3: Implement exact swap plan**

Plan persists keyset IDs, fee snapshot, every blinded message `B_`, output amount, output secret, blinding factor, and serialized request bytes before send. cashu-ts stays behind adapters; domain sees DTOs only. Proof verifier derives every `Y = hash_to_curve(secret)`, validates keyset/mint/unit, verifies available NUT-12 DLEQ, enforces requested NUT-10 locks, and calculates NUT-02 exact net amount before `prepare`. Sender wallet durably reserves one proof set per delivery. Mint capability discovery reads NUT-06. Replay exact bytes only when NUT-19 advertises `/v1/swap` and TTL remains valid. Otherwise NUT-09 restores same outputs. NUT-07 `SPENT` without own signatures yields `processing/recovery_blocked`, never credit. Compose profiles run both Nutshell and CDK mints in scheduled lanes.

- [x] **Step 4: Run real mint response-loss/restart lane**

Run: `pnpm --filter @cashu-fault-lab/reference-receiver test -- real-mint.test.ts nut09-recovery.test.ts nut19-replay.test.ts`

Expected: one recovered output set and credit after process restart.

- [x] **Step 5: Commit**

```bash
git add apps/reference-receiver infra/compose
git commit -m "feat: settle and recover against real Cashu mint"
```

### Task 12: Reports, CLI, and Replayable Artifacts

**Files:**

- Create: `packages/report/package.json`
- Create: `packages/report/src/redact.ts`
- Create: `packages/report/src/json.ts`
- Create: `packages/report/src/junit.ts`
- Create: `packages/report/src/html.ts`
- Create: `packages/report/test/report.test.ts`
- Create: `apps/lab-cli/package.json`
- Create: `apps/lab-cli/src/index.ts`
- Create: `apps/lab-cli/test/cli.test.ts`

**Interfaces:**

- Produces: `pnpm lab up|run|matrix|replay|report`; JSON/JUnit/static HTML redacted evidence.

- [x] **Step 1: Write failing redaction and CLI tests**

```ts
const output = renderJson(failureArtifactContainingFakeSecrets);
expect(output).not.toContain('secret-a');
expect(output).not.toContain('02deadbeef');
expect(output).toContain('payload_hash');

await expect(runCli(['replay', fixturePath])).resolves.toMatchObject({ exitCode: 0 });
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/report test && pnpm --filter @cashu-fault-lab/lab-cli test`

Expected: packages missing.

- [x] **Step 3: Implement report allowlist and CLI**

Report serialization is allowlist-only: seed, scenario, command/fault names, timestamps, component versions, capability manifests, image digests, receipt status/version/detail, payload/proof-set hashes, invariant result, redacted errors. HTML is self-contained static output with escaped data. CLI uses Commander 15.0.0 and exits nonzero on conformance failure or unreplayable artifact.

- [x] **Step 4: Run report secret scan and replay tests**

Run: `pnpm --filter @cashu-fault-lab/report test && pnpm --filter @cashu-fault-lab/lab-cli test`

Expected: artifacts replay; fake bearer patterns absent.

- [x] **Step 5: Commit**

```bash
git add packages/report apps/lab-cli package.json
git commit -m "feat: add replay CLI and redacted reports"
```

### Task 13: NIP-17/NIP-59 Delivery and Deterministic Nostr Fault Relay

**Files:**

- Create: `packages/nostr-delivery/package.json`
- Create: `packages/nostr-delivery/src/gift-wrap.ts`
- Create: `packages/nostr-delivery/src/inbox.ts`
- Create: `packages/nostr-delivery/src/index.ts`
- Create: `packages/nostr-delivery/test/gift-wrap.test.ts`
- Create: `apps/nostr-fault-relay/package.json`
- Create: `apps/nostr-fault-relay/src/relay.ts`
- Create: `apps/nostr-fault-relay/src/rules.ts`
- Create: `apps/nostr-fault-relay/test/relay.test.ts`
- Create: `scenarios/retry/nostr-response-lost.json`
- Create: `scenarios/retry/cross-transport-fallback.json`

**Interfaces:**

- Produces: verified NIP-17 kind-14 inner messages; NIP-59 seal/gift wrap; overlapping inbox recovery; deterministic relay faults.

- [x] **Step 1: Write failing wrap/verification/inbox tests**

```ts
const wrapped = wrapDelivery(payloadBytes, senderKey, receiverPubkey, deterministicRandom);
expect(unwrapDelivery(wrapped, receiverKey)).toEqual(payloadBytes);
expect(() => unwrapDelivery(sealRumorPubkeyMismatch, receiverKey)).toThrowError(/pubkey/i);
expect(await inbox.backfill({ since: lastSeen - 172_800 })).toContainEqual(expectedDelivery);
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/nostr-delivery test && pnpm --filter @cashu-fault-lab/nostr-fault-relay test`

Expected: packages missing.

- [x] **Step 3: Implement current NIP behavior**

Use nostr-tools 2.23.12 NIP-44 encryption, kind 13 signed seal, kind 1059 gift wrap, kind 14 unsigned rumor. Verify gift-wrap signature, decrypt seal, verify seal signature, require seal pubkey equals rumor pubkey, require receiver `p` tag. Fresh wrapper key/timestamp per retry; inner delivery bytes unchanged. Relay `OK` is transport acceptance only. Query overlap covers NIP-17 randomized timestamps up to two days.

- [x] **Step 4: Implement relay rules and cross-transport scenarios**

Relay supports duplicate publish, drop `OK`, delayed history, reorder, disconnect, reconnect/backfill, and fresh wrappers. HTTP then Nostr delivery of same inner payload must converge on one receiver record/credit.

- [x] **Step 5: Run Nostr and cross-transport tests**

Run: `pnpm --filter @cashu-fault-lab/nostr-delivery test && pnpm --filter @cashu-fault-lab/nostr-fault-relay test && pnpm --filter @cashu-fault-lab/scenario-runner test`

Expected: one settlement under multi-relay duplicate and HTTP/Nostr fallback.

- [x] **Step 6: Commit**

```bash
git add packages/nostr-delivery apps/nostr-fault-relay scenarios apps/reference-sender apps/reference-receiver
git commit -m "feat: add faultable NIP-17 payment delivery"
```

### Task 14: cashu-ts and Rust CDK Adapters, Compatibility Matrix

**Files:**

- Create: `adapters/cashu-ts/package.json`
- Create: `adapters/cashu-ts/src/server.ts`
- Create: `adapters/cashu-ts/test/contract.test.ts`
- Create: `adapters/cdk/Cargo.toml`
- Create: `adapters/cdk/src/main.rs`
- Create: `adapters/cdk/src/contract.rs`
- Create: `adapters/cdk/tests/contract.rs`
- Create: `scenarios/conformance/legacy-nut18.json`
- Create: `scenarios/conformance/delivery-v1.json`
- Create: `scenarios/conformance/nut26-known-mismatch.json`
- Create: `packages/scenario-runner/test/matrix.test.ts`

**Interfaces:**

- Produces: two independent implementation adapters; sender/receiver matrix; explicit NUT-26 mismatch evidence.

- [x] **Step 1: Write failing adapter contract and matrix tests**

```ts
for (const adapter of [cashuTsAdapter, cdkAdapter]) {
  expect(await validateAdapter(adapter.baseUrl)).toEqual({ ok: true });
}
for (const sender of adapters) {
  for (const receiver of adapters) {
    expect((await matrix.run('delivery-v1', sender, receiver)).status).toBe('passed');
  }
}
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @cashu-fault-lab/scenario-runner test -- matrix.test.ts && cargo test --manifest-path adapters/cdk/Cargo.toml`

Expected: adapters missing.

- [x] **Step 3: Implement thin adapters**

cashu-ts adapter uses `@cashu/cashu-ts@4.7.2`; Rust adapter uses `cdk = "=0.17.3"`. Both expose exact adapter contract; neither hides transport order, retry semantics, proof state, receipt interpretation, or implementation errors. Unsupported capabilities return `N/A` with reason.

- [x] **Step 4: Add NUT-18/NUT-26 codec evidence**

Pin encoded vectors to upstream lock. NUT-18 `creqA` Nostr uses `nprofile` plus `[["n","17"]]`. Current NUT-26 NIP-04/raw-x-only transport mapping is a known-failure scenario until upstream resolution; do not silently reinterpret it as passing NIP-17 conformance.

- [x] **Step 5: Run matrix**

Run: `pnpm lab matrix --profile delivery-v1 && pnpm lab matrix --profile legacy-nut18`

Expected: mandatory supported pairs pass; unsupported optional capabilities show `N/A`; known NUT-26 mismatch reported separately.

- [ ] **Step 6: Commit**

```bash
git add adapters scenarios packages/scenario-runner
git commit -m "feat: add cross-language Cashu adapter matrix"
```

### Task 15: Security, Fuzz, Browser, CI, and Release Gate

**Files:**

- Create: `scenarios/security/redirect-leak.json`
- Create: `scenarios/security/ssrf.json`
- Create: `scenarios/security/cors.json`
- Create: `scenarios/security/malformed-input.json`
- Create: `scenarios/crash-recovery/all-failpoints.json`
- Create: `scenarios/concurrency/cross-transport-storm.json`
- Create: `.github/workflows/nightly.yml`
- Create: `.github/workflows/weekly.yml`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/adrs/001-delivery-semantics.md`
- Create: `docs/adapter-guide.md`
- Create: `adapters/template/README.md`

**Interfaces:**

- Produces: full MVP acceptance gate; scheduled stress/security lanes; integration guide.

- [ ] **Step 1: Add failing security/property scenarios**

```ts
fc.assert(
  fc.property(malformedPayloadArbitrary(), (payload) => {
    const result = receiver.parse(payload);
    expect(stableValidationResult(result)).toBe(true);
  }),
);
expect(reportFiles).not.toContainBearerMaterial();
expect(await redirectScenario()).toMatchObject({ followedRedirect: false, proofLeak: false });
```

- [ ] **Step 2: Verify RED**

Run: `pnpm lab run security/malformed-input && pnpm lab run security/redirect-leak`

Expected: scenarios/CLI coverage missing.

- [ ] **Step 3: Implement complete scenario lanes**

PR: schemas/vectors/unit, one PostgreSQL, one real mint, HTTP/Nostr golden paths, response-loss, ten fixed seeds. Nightly: all supported pairs, two mints, every crash point, concurrent duplicate storms, 100 seeds. Weekly: pairwise faults, long recovery, malformed CBOR/Bech32m/JSON, SSRF/DNS rebinding, DLEQ/NUT-10 failures, browser CORS, real relay.

- [ ] **Step 4: Run complete local gate**

Run:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:consumer
pnpm audit --prod
cargo fmt --manifest-path adapters/cdk/Cargo.toml --check
cargo clippy --manifest-path adapters/cdk/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path adapters/cdk/Cargo.toml
pnpm lab run retry/response-lost --sender reference-ts --receiver reference-ts
pnpm lab run crash-recovery/all-failpoints --sender reference-ts --receiver reference-ts
pnpm lab matrix --profile delivery-v1
pnpm lab report
```

Expected: every supported mandatory scenario passes; artifacts contain no bearer material; known upstream mismatches isolated as expected/linked evidence.

- [ ] **Step 5: Commit**

```bash
git add scenarios .github docs adapters/template
git commit -m "ci: enforce end-to-end Cashu fault lab gate"
```

## Completion Gate

- [ ] Sparse arrays and invalid initial receipt versions fail with stable errors.
- [ ] Public schemas/vectors allow independent implementation without private guidance.
- [ ] Independent oracle imports no implementation under test.
- [ ] Same delivery repeated 100 times produces one swap plan and one credit.
- [ ] Same delivery ID plus different payload rejects before proof consumption.
- [ ] Same proofs under another delivery ID conflict without ownership disclosure.
- [ ] Lost receiver response retries same payload and converges to stored receipt.
- [ ] Lost mint response plus restart recovers exact outputs through NUT-19 or NUT-09.
- [ ] NUT-07 `SPENT` alone never creates credit.
- [x] HTTP and NIP-17 delivery of same logical payment have one effect.
- [ ] cashu-ts and CDK adapters pass supported T0-T3 evidence.
- [ ] JSON/JUnit/HTML reports replay and contain no bearer material.
- [ ] PR/nightly/weekly/release gates match design.
- [ ] No new NUT required for harness operation; experimental receipt profile remains versioned until interoperability evidence supports standardization.
