# Wallet Integration Design

**Date:** 2026-07-20  
**Status:** Approved in conversation; awaiting written-spec review  
**Target:** Raise Cashu Fault Lab from a source-only reference harness to an externally usable interoperability lab with executable independent wallet pairs.

## 1. Outcome

An operator can start two wallet adapters, register them without changing lab source code, and run the same delivery scenarios and compatibility matrix used by the reference implementation.

The lab controls scenarios and faults. Each adapter delegates Cashu operations to the implementation under test and returns contract-validated evidence. An adapter must not manufacture a passing receipt, proof state, or ledger credit.

This work does not require a new Cashu NUT. It implements the existing experimental `cashu-delivery-v1` lab profile and records evidence that can later support or reject a standards proposal.

## 2. Scope

### Included

- A production-quality HTTP implementation of the existing `AdapterClient` interface.
- A versioned adapter manifest and dynamic CLI/runtime discovery.
- Dynamic sender/receiver compatibility matrices.
- External-pair scenario orchestration through the existing fault and oracle boundaries.
- Funded cashu-ts and CDK test adapters using real wallet-library operations.
- At least one passing cross-language `delivery-v1` direction for the first milestone, with the reverse direction required for the higher maturity target and release gate.
- Real-mint HTTP delivery, duplicate, lost-response, and receipt-recovery evidence.
- Contract, integration, restart, redaction, and clean-checkout tests.

### Excluded

- Changes to Cashu mint cryptography or endpoints.
- A hosted certification service.
- Production wallet user interfaces.
- Test-control endpoints in production wallet builds.
- Claiming an accepted Cashu standard or ecosystem certification.
- Adding Kubernetes, queues, or a general plugin framework.

## 3. Approaches considered

### A. Compile adapters into the monorepo

This is closest to the current runtime. It is simple locally but every new wallet requires a lab code change and release. It creates implementation lock-in and is rejected as the primary integration model.

### B. Load JavaScript plugins

Plugins reduce HTTP overhead, but exclude Rust, mobile, daemon, and closed-source wallets. They also execute third-party code inside the oracle process. This is rejected.

### C. Register language-neutral HTTP adapters

This is the selected design. Wallets run in separate processes or containers and expose the existing seven-route control contract. The lab discovers capabilities and treats every adapter uniformly. Built-in reference lanes remain available for fast local tests.

## 4. Adapter registration

The primary configuration is a versioned JSON manifest:

```json
{
  "schemaVersion": 1,
  "adapters": [
    {
      "id": "cashu-ts",
      "url": "http://127.0.0.1:4101",
      "tokenEnv": "CFL_CASHU_TS_TOKEN"
    },
    {
      "id": "cdk",
      "url": "http://127.0.0.1:4102",
      "tokenEnv": "CFL_CDK_TOKEN"
    }
  ]
}
```

Rules:

- `schemaVersion` is exactly `1`.
- Adapter IDs are unique and use a bounded lowercase identifier format.
- URLs must be loopback HTTP by default. Non-loopback endpoints require an explicit unsafe-test-network flag and HTTPS.
- Bearer tokens are read from named environment variables. Tokens never appear in the manifest, command line, artifacts, or logs.
- Unknown fields fail closed.
- The existing in-process `reference-ts` participant remains available when no manifest is supplied.

CLI additions:

```text
cashu-fault-lab run <scenario> --adapters adapters.json --sender cashu-ts --receiver cdk
cashu-fault-lab matrix --adapters adapters.json --profile delivery-v1
```

Inline URL flags are intentionally omitted from the first version. A manifest is reproducible, easier to validate, and safer for tokens.

## 5. HTTP adapter client

`HttpAdapterClient` implements the existing `AdapterClient` interface:

```text
GET  /v1/capabilities
POST /v1/reset
POST /v1/requests
POST /v1/send
GET  /v1/deliveries/:id
GET  /v1/ledger
GET  /v1/proofs
```

Client requirements:

- Validate every request before sending and every successful response before returning.
- Send the bearer token only to the configured origin.
- Disable redirects.
- Apply bounded connect/request timeouts and response-size limits.
- Treat `501 {"status":"N/A"}` as unsupported capability, not a transport failure.
- Preserve stable public error codes while redacting dependency messages and response bodies.
- Never retry `POST /v1/send` inside the client. Scenario policy owns retries so fault evidence stays observable.
- Permit injected `fetch` and clock dependencies for deterministic tests.

## 6. Dynamic runtime and matrix

The runtime loads the manifest, creates one client per adapter, calls `/v1/capabilities`, and constructs matrix participants from the returned declarations. Static capability claims in the CLI are removed for external adapters.

For each pair:

1. Confirm the sender and receiver declare the requested profile and roles.
2. Reset both adapters with the same run seed.
3. Ask the receiver to create a request.
4. Ask the sender to send or resume one logical payment.
5. Poll the receiver's delivery receipt only when the scenario requires status recovery.
6. Collect receiver ledger and proof evidence.
7. Feed observations to the independent oracle.
8. Report pass, failure, or `N/A` with implementation versions and evidence tier.

The matrix never counts aliases of the same implementation identity as independent passes. The release gate requires distinct implementation IDs and languages plus distinct real-mint identities.

## 7. External scenario driver

`ExternalAdapterScenarioDriver` implements the existing `ScenarioDriver` interface. It coordinates adapter clients and the existing HTTP/Nostr fault controllers without importing wallet code.

The first external scenarios are:

- Direct HTTP delivery.
- Request loss before receiver acceptance.
- Receiver commit followed by response loss.
- Duplicate delivery storm.
- Same delivery ID with changed payload rejection.
- Same proof set under another delivery ID rejection.
- Sender retry after an ambiguous response.
- Cross-process adapter restart where supported.

Nostr and complete crash-boundary coverage remain subsequent gates in the same project, but HTTP cross-language evidence must be real before it can count above T0.

## 8. Per-wallet implementation

### 8.1 cashu-ts adapter

The existing Fastify server remains the control surface. The missing `CashuTsAdapterOperations` implementation must:

- Create and fund an isolated cashu-ts wallet against a pinned fake-value mint.
- Persist the delivery ID, exact payload bytes, proof reservation, and highest receipt.
- Send through the wallet/library transport path.
- Resume the same logical payment after loss.
- Expose proof-state hashes without exposing proof material.
- Expose durable receiver ledger evidence when running the receiver role.

### 8.2 CDK adapter

The existing Axum server is upgraded from T0 stubs to funded operations. It must implement the same observable contract using CDK wallet APIs and Rust-owned persistence. It must not call TypeScript reference sender or receiver code.

### 8.3 Funding and reset

The seven-route contract remains unchanged. In explicit lab mode, `reset` provisions deterministic test state using pinned fake-wallet mint fixtures. Production mints and real Lightning payments are not required. Funding details remain adapter-internal and are recorded only as non-secret component evidence.

## 9. Persistence and restart

Sender adapters must durably serialize one delivery across processes and persist proof reservations before transport. Receiver adapters must durably enforce delivery, proof-set, single-use-request, settlement-plan, and merchant-credit uniqueness.

Each adapter may use its native persistence system. The lab tests observable behavior rather than prescribing database tables. Process-local memory may pass T0/T1 development lanes but cannot claim durable restart or T3 evidence.

## 10. Security

- Control servers bind to loopback unless explicitly placed on an isolated test network.
- Bearer authentication is mandatory outside explicit in-process test mode.
- Redirects are disabled for control and payment delivery.
- Manifests and reports contain no tokens, proofs, private keys, raw payment payloads, or wallet databases.
- Test reset/funding operations never ship in production wallet builds.
- Adapter errors are mapped to stable codes; raw upstream bodies are not copied into artifacts.
- The lab treats adapters as untrusted claims and corroborates settlement with proof and ledger evidence.

## 11. Error handling

- Invalid manifest or contract response: fail before payment execution.
- Undeclared profile or role: `N/A`.
- Adapter unavailable before send: infrastructure failure, no conformance result.
- Ambiguous send response: continue scenario recovery; never classify as rejection.
- Invalid or conflicting receipt: conformance failure.
- Missing proof or ledger evidence: cap the achieved evidence tier instead of synthesizing a pass.
- Restart unsupported: `N/A` for restart-specific lanes only.

## 12. Test strategy

Implementation follows red-green-refactor.

1. Contract tests for manifest parsing and `HttpAdapterClient` request/response behavior.
2. Security tests for redirect blocking, token origin binding, size limits, timeouts, and redaction.
3. Runtime tests proving adapters are discovered dynamically and unsupported pairs remain `N/A`.
4. Pair-driver tests with real loopback adapter servers.
5. cashu-ts funded integration tests against pinned Nutshell and CDK mints.
6. CDK funded integration tests against the same mint set.
7. Cross-language response-loss and duplicate scenarios.
8. Process-restart tests over durable adapter state.
9. Full TypeScript, Rust, browser, consumer, audit, matrix, and clean-checkout gates.

Every new production behavior must first have a failing test that demonstrates the missing behavior.

## 13. Acceptance criteria

- A new adapter can be registered through a manifest without editing lab source.
- The CLI discovers truthful capabilities from running processes.
- cashu-ts and CDK execute funded operations rather than return `N/A`.
- At least one cashu-ts/CDK sender-receiver direction passes direct delivery, duplicate, and lost-response recovery using a real mint.
- The reverse direction is executable and either passes or returns a precise role-specific `N/A`; a remaining `N/A` caps this project near the lower maturity target and keeps the release gate closed.
- One logical payment produces one redemption plan and one durable merchant credit after retries.
- Reports identify adapter versions, achieved evidence tier, mint identity, seed, and relevant invariant evidence without secrets.
- Existing reference lanes and protocol mismatch reporting remain unchanged.
- The full repository verification suite and clean-checkout CI pass.

## 14. Maturity effect

Generic external registration plus one real cross-language funded pair moves the project from a reference-only lab toward roughly 70/100 completion. Two directions, durable restart, real relay evidence, and release-grade provenance move it toward 80/100. Ecosystem certification and a standards proposal remain separate later work.
