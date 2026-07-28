# Cashu Fault Lab — experimental v0.1 developer preview

Cashu Fault Lab checks payment delivery across retries, duplicates, transport loss, and process recovery. Funded cashu-ts has delivery-v1 sender and receiver paths over HTTP and NIP-17 Nostr, PostgreSQL-backed restart-safe sender state, optional T3 receiver evidence, and real SIGKILL coverage at four sender and six receiver boundaries. CDK remains a funded sender adapter against the reference receiver at T1.

This is an experimental v0.1 developer preview, not certification. The strict gate remains blocked on an independent wallet receiver, distinct qualifying mint identities, trustworthy build provenance, and external integrations. See the [release notes](docs/releases/v0.1.0.md) and [certification checklist](docs/releases/v0.1.0-checklist.md).

The lab implements an experimental `cashu-delivery-v1` application profile on existing Cashu and Nostr protocols. Harness operation does not require a new NUT. See [ADR 001](docs/adrs/001-delivery-semantics.md) for the standardization boundary.

## Requirements

- Node.js 24
- pnpm 11.15.0
- Rust 1.97.0 for the CDK adapter
- Docker for PostgreSQL and real-mint lanes

## Install and verify

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm test             # Docker-free default
pnpm test:integration # PostgreSQL/Testcontainers; skips if Docker is unavailable
pnpm test:funded      # strict real-mint and funded-wallet lanes
pnpm build
pnpm test:consumer
```

## Website

```bash
pnpm website:dev
pnpm website:test
pnpm website:build
pnpm website:test:e2e
```

The site reads `README.md`, `docs/`, `spec/`, `scenarios/`, and the reviewed demo artifact during
its build. Preview URLs are deployment outputs returned to the user rather than committed as
canonical project URLs.

## Run the deterministic demo

```bash
pnpm lab demo --seed cashu-fault-lab-v0.1.0-demo --artifact docs/examples/v0.1.0-demo.json --report docs/examples/v0.1.0-demo.html
```

The command starts the local reference stack, injects response loss, verifies convergence, writes secret-redacted evidence, and cleans up services it started.

`pnpm test:all` runs unit, integration, and funded tiers in order. Run `pnpm lab doctor`
to see which tiers are runnable and the exact command for each one. Funded tests never
turn missing Docker, credentials, or endpoints into a passing result.

Run Rust adapter checks:

```bash
cargo fmt --manifest-path adapters/cdk/Cargo.toml --check
cargo clippy --manifest-path adapters/cdk/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path adapters/cdk/Cargo.toml
```

## Run fault scenarios

```bash
pnpm lab run scenarios/retry/response-lost.json \
  --sender reference-ts \
  --receiver reference-ts \
  --seed demo

pnpm lab run scenarios/crash-recovery/mint-response-lost.json --seed crash-demo
pnpm lab run scenarios/concurrency/cross-transport-storm.json --seed storm-demo
```

Each run writes `artifacts/latest.json` with mode `0600`. Artifact schema v2 contains one
structured result for each of the 18 invariants, including status, confidence, and safe evidence
references. Missing evidence is recorded as `not_observable`; it is never upgraded to a pass. The
repository ignores `artifacts/`.

Replay or render that artifact:

```bash
pnpm lab replay artifacts/latest.json
pnpm lab report
pnpm lab report artifacts/latest.json --format junit --output artifacts/result.xml
pnpm lab report artifacts/latest.json --format html --output artifacts/result.html
```

## Compatibility matrix

```bash
pnpm lab matrix --profile delivery-v1
pnpm lab matrix --profile legacy-nut18
pnpm lab matrix --profile nut26-nostr

# Hard release decision (currently expected to fail until the documented gaps close)
pnpm lab matrix --profile delivery-v1 \
  --release-policy spec/release-policy.json \
  --release-suite spec/release-suite.json
```

`delivery-v1` runs configured receipt and idempotency pairs. `legacy-nut18` reports `N/A` until executable legacy receiver adapters are wired; pinned `creqA` vectors remain covered by adapter contract tests. `nut26-nostr` reports the pinned NIP-04/raw-key versus NIP-17/`nprofile` mismatch as an expected failure.

`--min-passes` is a developer smoke-test threshold. It is not a release claim. Policy v3 binds the
decision to the exact release-suite bytes with SHA-256, replaces smoke invariants with a
conservative aggregate of suite-required invariants, and requires distinct implementations,
languages, source/build digests, mint identities, role-specific evidence floors, and accepted
evidence for every required invariant. Rejection codes are emitted in text, JSON, JUnit, and HTML
reports. The checked-in policy deliberately keeps the release blocked while these requirements are
unmet.

Bundled cashu-ts 4.7.2 provides funded delivery-v1 sender and receiver operations. HTTP runs by
default, NIP-17 Nostr is enabled with sender/receiver keys and relay URLs, and PostgreSQL supplies
durable receiver state. CDK 0.17.3 remains a funded T1 HTTP sender and explicitly returns `N/A` for
receiver operations. Adapter-reported ledger and proof observations remain `adapter_claimed`; a
strict run needs separately authenticated, read-only ledger and mint authorities. Release therefore
remains blocked until independent wallet receivers and evidence authorities produce at least two
qualifying pairs.

## Run funded wallet integrations

The local stack starts a pinned Nutshell mint, cashu-ts as a funded sender/receiver with PostgreSQL-backed receiver evidence and a local Nostr relay, the CDK sender adapter, the reference receiver, and the controllable HTTP fault gateway. All published ports bind to loopback.

```bash
export CFL_CASHU_TS_TOKEN=lab-only-cashu-ts-token
export CFL_CDK_TOKEN=lab-only-cdk-token
export CFL_REFERENCE_RECEIVER_TOKEN=lab-only-receiver-token
export CFL_HTTP_FAULT_GATEWAY_TOKEN=lab-only-fault-token
export CFL_REFERENCE_RECEIVER_CLAIM_KEY=ERERERERERERERERERERERERERERERERERERERERERE

docker compose -f infra/compose/wallet-adapters.compose.yml up --build -d --wait

export CFL_HTTP_FAULT_GATEWAY_URL=http://127.0.0.1:4300
pnpm lab matrix --profile delivery-v1 \
  --adapters spec/examples/adapters.local.json

pnpm lab run scenarios/retry/response-lost.json \
  --adapters spec/examples/adapters.local.json \
  --sender cashu-ts \
  --receiver reference-receiver \
  --seed funded-demo

pnpm lab run scenarios/crash-recovery/external-receiver-restart-after-settlement.json \
  --adapters spec/examples/adapters.local.json \
  --sender cdk \
  --receiver cashu-ts \
  --seed funded-receiver-restart

pnpm lab report
docker compose -f infra/compose/wallet-adapters.compose.yml down -v
```

Use `--sender cdk` to exercise the Rust wallet implementation. The stack is ephemeral and test-only: sender reservations, the local Nostr relay, and receiver evidence stores are reset through the adapter and compose lifecycle.

`spec/examples/adapters.local.json` is a schema-v2 smoke manifest without independent evidence
authorities. For strict qualification, add `evidence.ledger` and `evidence.mint` origins to each
receiver registration. Those origins and bearer tokens must be distinct from the wallet adapter;
the lab calls only their read-only `/v1/ledger`, `/v1/proofs`, and `/v1/redemptions` endpoints.
The redemption endpoint reports a cumulative start count for each delivery/proof-set binding;
a final `spent` state alone cannot prove at-most-once redemption.

## Current coverage

| Area                                       | Developer-preview evidence                                                                                                                                | Release gap                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| HTTP retry, response loss, and duplication | Real-mint T1 lane with cashu-ts/CDK senders plus the reference receiver; cashu-ts also has its own receiver path                                          | Independent wallet receiver                        |
| Funded NIP-17 Nostr delivery               | cashu-ts sender/receiver E2E over the repo's real WebSocket relay                                                                                         | Public relay hardening and broader wallet coverage |
| Durable receiver evidence                  | cashu-ts receiver can use PostgreSQL T3 credit/proof evidence and recover through six funded receiver crash boundaries                                    | Independent wallet receiver evidence               |
| NIP-17 and cross-transport convergence     | Packaged synthetic T0 lanes                                                                                                                               | Funded wallets and real relay                      |
| Receiver persistence and recovery          | PostgreSQL tests cover prepared recovery, ambiguous mint response, atomic credit, concurrent-worker leasing, and all six funded receiver crash boundaries | Independent receiver implementations               |
| Delay and reorder                          | HTTP gateway and Nostr relay component tests                                                                                                              | Packaged end-to-end lanes with injected clock      |
| Sender restart                             | Encrypted PostgreSQL reservation/session state and exact-payload replay pass all four funded sender crash boundaries                                      | Independent sender implementations                 |

The packaged `mint-response-lost` scenario exercises recovery orchestration with in-memory fakes. Durable restart claims come only from PostgreSQL integration tests. Scenario artifacts carry versioned capability and invariant evidence, but only `spec/release-policy.json` decides whether that evidence is release-qualifying.

`SenderState.withDeliveryLock` is a correctness boundary for sender adapters. Durable implementations must serialize one delivery across processes and bind the callback's `get`/`create`/`save` operations to the same lock or database session; nested lock acquisition is forbidden. The bundled in-memory state provides process-local serialization. `PostgresSenderState` provides cross-process delivery locks and AES-256-GCM encrypted records when initialized with a 32-byte state key and `migratePostgresSenderState(pool)`.

## Security lanes

```bash
pnpm lab run scenarios/security/redirect-leak.json
pnpm lab run scenarios/security/ssrf.json
pnpm lab run scenarios/security/cors.json
pnpm lab run scenarios/security/malformed-input.json
pnpm test:browser
```

The browser command launches Chromium and verifies trusted-origin access, attacker-origin blocking, and credentialed cross-origin blocking.

## Real mints

Start both pinned fake-wallet mints:

```bash
pnpm lab up --profile lab
```

Run the funded recovery and cross-language lanes against each pinned mint:

```bash
CFL_REAL_MINT_URL=http://127.0.0.1:3338 \
  pnpm --filter @cashu-fault-lab/reference-receiver exec vitest run test/docker-mint-e2e.test.ts
CFL_REAL_MINT_URL=http://127.0.0.1:3338 \
  pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/cross-language-docker.test.ts

CFL_REAL_MINT_URL=http://127.0.0.1:8085 \
  pnpm --filter @cashu-fault-lab/reference-receiver exec vitest run test/docker-mint-e2e.test.ts
CFL_REAL_MINT_URL=http://127.0.0.1:8085 \
  pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run test/cross-language-docker.test.ts
```

## Repository map

- `packages/delivery-core`: pure delivery codecs, hashes, receipts, and conflict rules
- `apps/reference-sender`: sender state and retry interfaces; bundled stores are in-memory, so production adapters must provide durable reservation, receipt state, and cross-process delivery locking
- `apps/reference-receiver`: transactional settlement, PostgreSQL, and recovery
- `packages/scenario-runner`: virtual scheduler, oracle feed, fault lanes, and replay
- `apps/http-fault-gateway` and `apps/nostr-fault-relay`: semantic transport faults
- `adapters`: cashu-ts, CDK, and adapter template
- `spec`: schemas, public vectors, invariants, and protocol lock

Read [adapter guide](docs/adapter-guide.md) before adding another wallet implementation.
