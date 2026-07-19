# Cashu Fault Lab Design

**Date:** 2026-07-19  
**Status:** Ready for review  
**Project:** Standalone, implementation-neutral Cashu interoperability and payment-delivery fault lab

## 1. Purpose

Cashu Fault Lab will test Cashu payment delivery across independent wallet and library implementations under duplication, delay, loss, reordering, ambiguous responses, process crashes, and transport fallback.

The project has two related outputs:

1. A useful conformance lab for the Cashu protocols that exist today.
2. An experimental `cashu-delivery-v1` profile that defines the retry and receipt behavior missing from NUT-18, backed by a reference implementation and executable evidence before any NUT proposal is submitted.

The project is Cashu-specific but must not be embedded in cashu-ts, CDK, Nutshell, or any other implementation. Those projects participate through language-neutral adapters. This prevents an implementation under test from also defining the oracle that judges it.

## 2. Correctness boundary

The lab will never claim “exactly-once delivery.” Its target guarantee is:

> A valid logical payment may be delivered at least once through HTTP, Nostr, or both, while the payee obtains the Cashu value at most once and a reference merchant ledger receives at most one corresponding credit.

`settled` has one Cashu-specific meaning: the payee has obtained or recovered valid replacement proofs for the exact persisted NUT-03 output plan. The following are not settlement:

- An HTTP request reaching the receiver.
- An HTTP 2xx response without a delivery receipt.
- A Nostr relay returning `OK`.
- A proof passing DLEQ validation.
- A payer observing its inputs as `SPENT` through NUT-07.

The experimental wire profile standardizes observable sender/payee behavior. It does not standardize merchant database tables, queue implementations, accounting software, or deployment architecture.

## 3. Conformance profiles

The lab exposes separate profiles so experimental guarantees are never attributed to current NUT-18.

### 3.1 `legacy-nut18`

Tests current NUT-18 and NUT-26 encoding, payload construction, transport ordering, HTTP delivery, NIP-17 delivery, requested mint/unit/amount handling, and optional NUT-10 requirements. Behavior not specified by current NUTs is reported as an observation rather than a conformance failure.

### 3.2 `delivery-v1`

Tests the experimental delivery identity, duplicate/conflict behavior, exact-payload retry, monotonic receipt states, cross-transport equivalence, request expiry, exact-net amount, and single-use behavior.

### 3.3 `resilient-recovery`

Adds crash-safe settlement after an ambiguous mint response. Passing this profile requires NUT-09 restore support. NUT-19 response caching improves recovery speed but is not sufficient by itself because its cache may expire or be volatile.

### 3.4 Evidence tiers

- **T0 — Codec:** request and receipt vectors can be parsed and generated.
- **T1 — Delivery:** the implementation can send or receive through the tested transport.
- **T2 — Settlement:** the payee can prove acquisition or recovery of replacement proofs.
- **T3 — Merchant effect:** the implementation exposes enough evidence to prove one durable reference-ledger credit.

An implementation that cannot expose a ledger can pass T0–T2 and reports T3 as not applicable.

## 4. Repository architecture

The project is a pnpm monorepo. TypeScript is used for orchestration and the first reference implementation, but every system under test is isolated behind an HTTP/JSON adapter and may be written in any language.

```text
cashu-fault-lab/
  spec/
    delivery-v1.md
    invariants.md
    threat-model.md
    schemas/
    vectors/
  packages/
    delivery-core/
    adapter-contract/
    oracle/
    scenario-runner/
    report/
  apps/
    reference-sender/
    reference-receiver/
    lab-cli/
    http-fault-gateway/
    nostr-fault-relay/
  adapters/
    cashu-ts/
    cdk/
    nutshell/
  scenarios/
    conformance/
    retry/
    crash-recovery/
    concurrency/
    security/
  infra/
    compose/
    migrations/
    ci/
  docs/
    adrs/
```

### 4.1 Technology decisions

- Node.js 24 LTS for project tooling and reference services.
- pnpm 11 workspaces and Turborepo for task orchestration.
- Strict TypeScript for the control plane.
- JSON Schema 2020-12 as the language-neutral API and vector schema format.
- Fastify for reference HTTP services and adapter control APIs.
- PostgreSQL 17 with explicit SQL migrations for durable receiver state.
- Kysely for typed queries without hiding transaction boundaries.
- Ajv for schema validation.
- cashu-ts behind a gateway interface in the first reference implementation.
- nostr-tools behind a transport interface for NIP-17 support.
- Vitest for examples/unit/integration tests.
- fast-check for seeded model-based and stateful testing.
- Testcontainers and Docker Compose for real mint, database, relay, and adapter processes.
- A semantic HTTP gateway and deterministic Nostr relay for application-message faults.
- Toxiproxy only for lower-level connection faults.
- GitHub Actions for pull-request, nightly, and weekly lanes.

The independent oracle must not import cashu-ts, CDK, the reference receiver’s state machine, or receiver persistence code. It consumes only adapter observations and lab-controlled mint/transport evidence.

## 5. Component responsibilities

### 5.1 `delivery-core`

Provides transport-independent experimental types and pure functions:

- Request and delivery identifiers.
- Mint URL normalization.
- Deterministic payload and proof-set fingerprints.
- Receipt types and monotonic status validation.
- Amount and expiry validation.
- Duplicate/conflict classification.

It contains no HTTP, Nostr, database, mint client, wallet, or ledger code.

### 5.2 `adapter-contract`

Defines the OpenAPI/JSON Schema contract used by every wallet adapter. Generated clients are conveniences; the schema is normative for the lab.

### 5.3 `reference-sender`

Decodes receiver-created requests, creates logical payments, reserves proofs while an outcome is ambiguous, retries the exact logical delivery, handles HTTP and NIP-17 receipts, and never silently creates fresh proofs after a timeout.

### 5.4 `reference-receiver`

Runs HTTP and NIP-17 controllers over the same `acceptDelivery` application use case. It durably deduplicates deliveries, persists an exact swap plan, redeems or restores outputs, atomically commits settlement evidence plus one ledger credit, and publishes receipts through an outbox.

### 5.5 `oracle`

Maintains an independent sequential model of requests, deliveries, proof ownership, replacement outputs, merchant credits, and receipts. It checks safety after every observed transition and liveness only after injected faults stop.

### 5.6 `scenario-runner`

Executes seeded scenario commands through adapters and fault controllers. It records invocation/completion histories, supports deterministic replay, and asks fast-check to shrink failing histories.

### 5.7 Fault services

The HTTP gateway and Nostr relay manipulate complete logical messages. They can forward a request, permit the downstream commit, and then drop the response. Toxiproxy remains available for TCP timeout/reset/latency cases but cannot replace semantic faults.

### 5.8 `report`

Produces JSON, JUnit, and static HTML artifacts containing the random seed, minimized trace, capability manifests, component versions, image digests, and a redacted timeline.

## 6. Experimental `cashu-delivery-v1` contract

### 6.1 Negotiation

A receiver generates `i` from exactly 16 cryptographically random bytes encoded as base64url without padding. It advertises version 1 and the request expiry in every NUT-18 transport that supports the experimental profile:

```json
[
  ["delivery", "1"],
  ["expires_at", "1784400300"]
]
```

The expiry is Unix time in seconds, must be later than request creation, and may be at most 24 hours after creation. The sender uses the extension only when this exact version is advertised. Unknown versions are not treated as version 1. A receiver may also publish a separate legacy transport entry. The sender continues to follow the NUT-18 transport order.

### 6.2 Extended payload

The ordinary NUT-18 `PaymentRequestPayload` is extended only after negotiation:

```json
{
  "id": "receiver-request-id",
  "memo": "optional payer memo",
  "mint": "https://mint.example",
  "unit": "sat",
  "proofs": [],
  "delivery": {
    "v": 1,
    "id": "d9vV2xH6xK2rtM9pY3Z8Lw",
    "created_at": 1784399400,
    "expires_at": 1784400300
  }
}
```

Requirements:

- The request ID and delivery ID are each exactly 16 cryptographically random bytes encoded as base64url without padding.
- A delivery ID is generated by the sender and remains unchanged across every retry, Nostr re-wrap, relay, and transport fallback.
- `delivery.expires_at` exactly copies the expiry advertised by the selected request transport.
- Retries use the exact same inner payload and proofs while the outcome is ambiguous.
- The sender reserves those proofs until `settled`, definitive `rejected`, or an explicit operator recovery action.
- The receiver permits 60 seconds of clock skew when enforcing expiry.
- The serialized extended payload is limited to 65,536 bytes and 256 proofs. Larger deliveries are rejected with HTTP `413` or the corresponding Nostr rejection receipt.

### 6.3 Fingerprints

`payload_hash` is SHA-256 over the RFC 8949 deterministic-CBOR encoding of this exact array:

```text
[
  "cashu-delivery-v1/payload",
  request_id,
  memo_or_null,
  normalized_mint_url,
  unit,
  complete_proofs_in_original_order,
  1,
  created_at,
  expires_at
]
```

The delivery ID is excluded so attempts to bind the same delivery ID to another payload can be detected directly. Proof maps use their complete NUT-00 fields and deterministic-CBOR map ordering.

`proof_set_hash` is SHA-256 over the deterministic-CBOR encoding of this exact array:

```text
[
  "cashu-delivery-v1/proof-set",
  normalized_mint_url,
  unit,
  proof_Y_values_sorted_by_compressed_point_bytes
]
```

Each proof `Y = hash_to_curve(secret)` is encoded as its 33-byte compressed SEC1 point before bytewise ascending sorting. The reference receiver stores a keyed HMAC of individual `Y` values for durable uniqueness and diagnostics; raw proof identifiers are not exported.

Mint URLs are normalized by requiring HTTPS except for explicit loopback test endpoints, lowercasing scheme and host, removing the default port, rejecting credentials/query/fragment, and removing a single trailing slash while preserving a non-root path.

### 6.4 Duplicate and conflict semantics

- Same delivery ID and same payload hash: return the current or terminal result without starting another settlement.
- Same delivery ID and different payload hash: conflict.
- Same proof-set hash under another delivery ID: conflict without revealing the owning delivery; never create another settlement. The same delivery ID arriving through another transport remains an ordinary duplicate.
- For a single-use request, only one delivery may hold the settlement reservation. A definitive pre-consumption rejection releases the reservation. An ambiguous mint outcome retains it. Settlement makes it permanent.
- Multi-use requests permit distinct deliveries but retain proof-level uniqueness.

### 6.5 Amount

Version 1 accepts exact net payment only:

```text
sum(input proof amounts) - NUT-02 input fees == requested amount
```

Overpayment, change, refunds, partial payments, and multi-mint splitting are outside version 1.

### 6.6 Receipt states

The wire contract has three states:

- `processing`: durably accepted; settlement is in progress or its mint outcome is being recovered.
- `settled`: the payee obtained or recovered valid replacement proofs for the persisted swap plan.
- `rejected`: terminal; the payee did not consume the inputs and will never attempt them.

Receipts contain:

```json
{
  "profile": "cashu-delivery-v1",
  "request_id": "receiver-request-id",
  "delivery_id": "sender-delivery-id",
  "payload_hash": "hex-sha256",
  "status": "processing",
  "status_version": 1,
  "mint": "https://mint.example",
  "unit": "sat",
  "amount": 100,
  "detail_code": "redeeming"
}
```

`status_version` starts at 1 and increases once for every durable status or detail-code transition. Returning a duplicate’s unchanged state does not increment it. `settled` and `rejected` are terminal. An out-of-order receipt with a lower version cannot downgrade sender state. `detail_code` is diagnostic and does not change the state semantics. `processing/recovery_blocked` is used when inputs appear consumed but the intended outputs cannot yet be recovered.

### 6.7 HTTP mapping

- `200`: settled receipt.
- `202`: processing receipt, including `Retry-After`.
- `409`: delivery/payload/proof/single-use conflict.
- `410`: expired request before durable acceptance.
- `413`: payload or proof-count limit exceeded.
- `422`: deterministic permanent rejection.
- `429` and `5xx`: retry the exact same delivery with backoff and jitter.
- Network timeout or response loss: outcome unknown; retry the exact same delivery.

Repeated POST of the same payload is the mandatory status recovery mechanism, avoiding a mandatory new public GET endpoint. The reference receiver additionally exposes authenticated status through its lab adapter, not as part of the wire profile.

The reference sender uses exponential retry starting at 250 milliseconds, capped at 30 seconds, with full jitter; lab scenarios replace wall time with the virtual scheduler. HTTP implementations require HTTPS except loopback, `Content-Type: application/json`, and disabled redirects for proof-bearing requests. Browser receivers answer `OPTIONS` and allow only configured origins, `POST`, `OPTIONS`, and `Content-Type`; wildcard origins are disabled when credentials are enabled.

### 6.8 Nostr mapping

The inner NIP-17 message contains the extended payload. The payee replies using an encrypted NIP-17 message containing the receipt. Relay `OK` is transport acceptance only. Outer gift-wrap IDs and timestamps are never business deduplication keys. The sender retains a recoverable per-delivery reply key and queries with an overlapping history window to account for randomized gift-wrap timestamps.

The receiver verifies the gift-wrap signature and requires the seal pubkey to equal the inner rumor pubkey before processing the payment.

## 7. Reference receiver persistence and recovery

PostgreSQL contains:

- `payment_requests` keyed by receiver/request ID.
- `deliveries` uniquely keyed by delivery ID and bound to one payload hash.
- `proof_claims` uniquely keyed by tenant, normalized mint, unit, and HMACed proof `Y`.
- `swap_plans` containing encrypted exact request bytes, blinded outputs, output secrets, and blinding factors.
- `merchant_credits` uniquely keyed by delivery ID.
- `receipt_outbox` uniquely keyed by delivery ID and status version.

Terminal receipts are retained for at least 30 days after request expiry. HMACed proof claims and merchant settlement references are retained without automatic expiry so delayed replays cannot create a new credit. Raw incoming bearer proofs and encrypted swap material are deleted after the configured audit period once terminal settlement and backup requirements are satisfied.

The internal state machine is:

```text
ABSENT -> PREPARED -> REDEEMING -> SETTLED
   |                         |
   +------> REJECTED         +-> remains REDEEMING while ambiguous
```

`PREPARED` atomically records the inbox item, immutable payload binding, proof claims, single-use reservation, and encrypted exact swap plan before contacting the mint.

Recovery uses this order:

1. Replay the identical swap request when NUT-19 covers `/v1/swap` and the cache remains available.
2. Restore signatures for the exact persisted blinded outputs through NUT-09.
3. Treat NUT-07 proof state as supporting evidence only.
4. Remain nonterminal if the intended outputs cannot yet be recovered.

One local database transaction stores recovered proofs, creates the unique merchant credit, marks the delivery settled, and inserts the terminal receipt outbox row. Receipt publication is at-least-once.

## 8. Adapter control contract

Every adapter exposes:

```text
GET  /v1/capabilities
POST /v1/reset
POST /v1/fund
POST /v1/requests
POST /v1/payments/prepare
POST /v1/payments/{delivery_id}/send
GET  /v1/payments/{delivery_id}
GET  /v1/proofs
GET  /v1/ledger
POST /v1/test/failpoints
```

Capabilities declare supported NUTs, encodings, transports, browser/CORS behavior, persistence, receipt profile, and available evidence tier. The adapter must be thin and must not normalize away the tested implementation’s actual transport selection or success semantics.

`reset`, `fund`, ledger inspection, proof inspection, and failpoints are test-control operations and are never exposed by production wallet builds.

## 9. Fault and scenario model

The runner supports:

- Duplicate, drop, delay, and reorder of complete HTTP/Nostr messages.
- Request loss before receiver acceptance.
- Receiver acceptance followed by response loss.
- Mint commit followed by response loss.
- HTTP `429`, `5xx`, timeout, reset, redirect, and CORS failure.
- Nostr multi-relay duplication, lost relay acknowledgment, reconnect/backfill, delayed history, and fresh gift wrappers.
- Concurrent same-ID/same-payload, same-ID/different-payload, and same-proofs/different-ID races.
- Receiver, worker, mint, relay, and database restart.

Named crash points are:

```text
after_inbox_commit
before_mint_send
after_mint_commit_before_response
after_mint_response
before_output_persist
before_ledger_commit
after_ledger_commit
after_receipt_publish
```

Scenarios use a seeded virtual scheduler and never rely on sleep-based correctness assertions.

## 10. Oracle invariants

The oracle checks:

```text
credits(delivery_id) <= 1
credits(single_use_request_id) <= 1
owner(mint, unit, proof_Y) is unique
settled_receipt => exact planned outputs recovered
settled_receipt => one durable reference-ledger credit
duplicate delivery does not change ledger or value
HTTP and Nostr delivery of one logical payment have one effect
terminal status never regresses
committed state survives restart
```

Value conservation accounts for NUT-02 input fees. Liveness is conditional: after injected faults stop and required dependencies remain available, a valid repeatedly delivered payment converges to `settled`, definitive `rejected`, or an explicit nonterminal recovery condition. The lab never converts ambiguity into false success.

## 11. Security and privacy

- The lab uses isolated fake-value mints only.
- Raw proof secrets, `C`, witnesses, DLEQ blinding material, output secrets, blinding factors, and complete payloads never appear in logs, reports, metrics, URLs, screenshots, or dead-letter records.
- Reports use run-scoped keyed HMAC fingerprints.
- Persisted swap plans are encrypted with a dedicated reference-receiver key.
- Adapter containers are restricted to the test network and run with CPU, memory, request-body, and proof-count limits.
- Redirect proof leakage, SSRF, DNS rebinding, hostile mint URLs, CORS, proof-count bombs, malformed CBOR/Bech32m, invalid DLEQ/NUT-10, and Nostr seal/rumor mismatch are mandatory security scenarios.
- Payment status is available only through the authenticated receipt channel or lab control network.
- Delivery IDs are scoped to one payment and are never public correlation identifiers.
- Failpoints compile only into test images and cannot be enabled in production builds.
- Dependencies and container images are pinned; release artifacts include an SBOM.

## 12. Developer experience

The primary commands are:

```text
pnpm lab up
pnpm lab run retry/response-lost --sender cdk --receiver reference-ts
pnpm lab matrix --profile legacy-nut18
pnpm lab replay artifacts/failure.json
pnpm lab report
```

The repository includes an adapter template, generated client, ten-minute integration guide, example CI workflow, capability report, and static HTML timeline. Unsupported optional capabilities appear as `N/A`, not failures. Every conformance failure names the violated profile rule and the evidence used.

## 13. CI strategy

- Pull requests: schemas, vectors, unit tests, reference sender/receiver, one real mint, HTTP/Nostr golden paths, essential lost-response cases, and ten deterministic seeds.
- Nightly: all available sender/receiver normal pairs, two real mints, transport fallback, every crash point, concurrent duplicate storms, and at least one hundred deterministic seeds.
- Weekly: pairwise fault combinations, long recovery runs, fuzz/malformed inputs, browser CORS lane, and a real Nostr relay lane.
- Release gate: `delivery-v1` mandatory scenarios pass on at least two independent language implementations and two real mint implementations.

A failing randomized test must replay from its artifact or be classified and fixed as a harness defect; it is never dismissed as flaky.

## 14. MVP and exclusions

The public MVP includes:

- HTTP and NIP-17 delivery.
- Reference sender and crash-safe reference receiver.
- PostgreSQL persistence.
- One real mint in pull-request CI and two in scheduled CI.
- cashu-ts and an independent CDK integration.
- Duplicate, concurrency, request-loss, response-loss, transport-fallback, and restart faults.
- CLI, JSON/JUnit reports, and a static trace viewer.
- Experimental profile, schemas, and executable vectors.

The MVP excludes:

- Production wallet UI and broad GUI automation.
- NUT-24 HTTP 402.
- Offline payment certification.
- Overpayment, partial payment, refunds, change, and multi-mint splitting.
- A production merchant platform or external accounting system.
- Kubernetes, Redis, Kafka, Temporal, or cloud deployment.
- New cryptography or a custom Cashu mint.
- Mandatory portable signed receipts.
- Formal certification claims.
- Submission of a finalized NUT before independent interoperability evidence exists.

## 15. Delivery milestones

1. Repository foundation, schemas, adapter contract, corrected executable vectors, and deterministic runner skeleton.
2. Pure delivery core and independent model oracle with property tests.
3. HTTP reference sender/receiver vertical slice with durable duplicate/conflict behavior.
4. Real NUT-03 settlement, NUT-02 fees, exact swap-plan persistence, NUT-09 recovery, and NUT-19 replay.
5. Semantic HTTP fault gateway, crash points, minimized traces, and reports.
6. NIP-17 delivery/receipt path and deterministic Nostr relay faults.
7. Independent CDK adapter and cross-language matrix.
8. Concurrency, security, fuzzing, and browser lanes.
9. Developer preview with adapter template and published compatibility results.
10. Maintainer discussion followed by a compact NUT proposal containing only proven observable behavior.

## 16. Acceptance criteria

The design is implemented successfully when:

- Corrected machine-readable vectors run against at least cashu-ts and CDK.
- The reference receiver returns the same semantic result for every duplicate of one delivery.
- One hundred concurrent identical deliveries create one settlement plan and one credit.
- Same delivery ID with a different payload is rejected without consuming its proofs.
- Same proofs delivered under HTTP, Nostr, or both create at most one settlement.
- A lost receiver response does not cause a second settlement.
- A lost mint response plus receiver restart recovers the intended outputs through NUT-09 when supported.
- Every named crash point preserves safety.
- No terminal receipt is emitted before the settlement transaction commits.
- No test/report artifact contains bearer proof material.
- At least one independent Rust implementation passes HTTP and NIP-17 `delivery-v1` scenarios.
- The experimental profile can be implemented from public documentation and vectors without private guidance.

## 17. Standardization path

The project will not begin by submitting a large NUT. It will:

1. Publish a minimal problem statement and reproducible lost-response trace.
2. File current NUT-18/NUT-26 vector and wording corrections separately.
3. Ask Cashu maintainers whether they prefer a new optional NUT or a backward-compatible NUT-18 amendment.
4. Publish experimental profile version 0.1 with schemas and vectors.
5. Validate TypeScript and Rust implementations through both transports and crash recovery.
6. Revise the profile from independent implementation feedback.
7. Publish interoperability, fault, and privacy results.
8. Submit only the proven wire contract for standardization, keeping reference database and ledger details as non-normative guidance.

The standardization milestone is reached only when an implementer unfamiliar with the authors can implement the profile and pass the lab without private clarification of “success,” “retry,” or “duplicate.”

## 18. Primary standards baseline

- NUT-18 Payment Requests: <https://github.com/cashubtc/nuts/blob/main/18.md>
- NUT-03 Swap: <https://github.com/cashubtc/nuts/blob/main/03.md>
- NUT-02 Input Fees: <https://github.com/cashubtc/nuts/blob/main/02.md>
- NUT-07 Proof States: <https://github.com/cashubtc/nuts/blob/main/07.md>
- NUT-09 Restore: <https://github.com/cashubtc/nuts/blob/main/09.md>
- NUT-19 Cached Responses: <https://github.com/cashubtc/nuts/blob/main/19.md>
- NUT-26 Payment Request Bech32m: <https://github.com/cashubtc/nuts/blob/main/26.md>
- NIP-17 Private Direct Messages: <https://github.com/nostr-protocol/nips/blob/master/17.md>
- NIP-59 Gift Wrap: <https://github.com/nostr-protocol/nips/blob/master/59.md>
