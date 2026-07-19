# Cashu Fault Lab

Cashu Fault Lab checks payment delivery across retries, duplicates, transport loss, and receiver recovery. Packaged synthetic lanes exercise one logical redemption and one merchant credit but claim only T0 preview evidence. PostgreSQL integration tests verify durable receiver recovery at implemented crash boundaries.

This is not yet broad wallet certification. Independent funded adapter pairs and the full named crash-boundary suite remain release-gated.

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
pnpm test
pnpm build
pnpm test:consumer
```

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

Each run writes `artifacts/latest.json` with mode `0600`. The repository ignores `artifacts/`.

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
```

`delivery-v1` runs configured receipt and idempotency pairs. `legacy-nut18` reports `N/A` until executable pair adapters are wired; pinned `creqA` vectors remain covered by adapter contract tests. `nut26-nostr` reports the pinned NIP-04/raw-key versus NIP-17/`nprofile` mismatch as an expected failure.

Bundled cashu-ts and CDK adapters claim T0 codec evidence. They return `N/A` for funded operations until wallet or receiver implementations are injected. Packaged reference lanes also remain T0 because their mint and wallet evidence is synthetic. Release requires at least two passing, real-mint `delivery-v1` pairs, so it remains blocked until an independent implementation is executable.

## Current coverage

| Area                                                                  | Developer-preview evidence                                                                                      | Release gap                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| HTTP/NIP-17 retry, loss, duplication, and cross-transport convergence | Packaged synthetic T0 lanes                                                                                     | Independent funded adapter pair, real mint, and real relay |
| Receiver persistence and recovery                                     | PostgreSQL tests cover prepared recovery, ambiguous mint response, atomic credit, and concurrent-worker leasing | Every named process-crash boundary                         |
| Delay and reorder                                                     | HTTP gateway and Nostr relay component tests                                                                    | Packaged end-to-end lanes with injected clock              |
| Sender restart                                                        | Durable state/reservation ports and terminal-state reconciliation                                               | Bundled durable sender-store adapter and restart lane      |

The packaged `mint-response-lost` scenario exercises recovery orchestration with in-memory fakes. Durable restart claims come only from PostgreSQL integration tests. Scenario artifacts are preview evidence; release-grade adapter/version/protocol-lock metadata remains part of the closed release gate.

`SenderState.withDeliveryLock` is a correctness boundary for sender adapters. Durable implementations must serialize one delivery across processes and bind the callback's `get`/`create`/`save` operations to the same lock or database session; nested lock acquisition is forbidden. The bundled in-memory state provides only process-local serialization.

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

Run one real-mint recovery test by setting `CFL_REAL_MINT_URL` to `http://127.0.0.1:3338` for Nutshell or `http://127.0.0.1:8085` for CDK.

## Repository map

- `packages/delivery-core`: pure delivery codecs, hashes, receipts, and conflict rules
- `apps/reference-sender`: sender state and retry interfaces; bundled stores are in-memory, so production adapters must provide durable reservation, receipt state, and cross-process delivery locking
- `apps/reference-receiver`: transactional settlement, PostgreSQL, and recovery
- `packages/scenario-runner`: virtual scheduler, oracle feed, fault lanes, and replay
- `apps/http-fault-gateway` and `apps/nostr-fault-relay`: semantic transport faults
- `adapters`: cashu-ts, CDK, and adapter template
- `spec`: schemas, public vectors, invariants, and protocol lock

Read [adapter guide](docs/adapter-guide.md) before adding another wallet implementation.
