# Cashu Fault Lab

Cashu Fault Lab checks payment delivery across retries, duplicates, transport loss, and receiver recovery. Funded cashu-ts now has delivery-v1 sender and receiver paths over HTTP and NIP-17 Nostr, with optional PostgreSQL T3 receiver evidence. CDK remains a funded sender adapter against the reference receiver at T1. Packaged synthetic lanes remain T0, while PostgreSQL integration tests verify durable receiver evidence.

This is not yet broad wallet certification. Independent wallet receiver adapters and the full named crash-boundary suite remain release-gated.

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

`delivery-v1` runs configured receipt and idempotency pairs. `legacy-nut18` reports `N/A` until executable legacy receiver adapters are wired; pinned `creqA` vectors remain covered by adapter contract tests. `nut26-nostr` reports the pinned NIP-04/raw-key versus NIP-17/`nprofile` mismatch as an expected failure.

Bundled cashu-ts 4.7.2 provides funded delivery-v1 sender and receiver operations. HTTP runs by default, NIP-17 Nostr is enabled with sender/receiver keys and relay URLs, and receiver evidence can be raised to T3 with PostgreSQL storage. CDK 0.17.3 remains a funded T1 HTTP sender and explicitly returns `N/A` for receiver operations. Release therefore remains blocked until independent wallet receivers produce at least two qualifying pairs.

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

pnpm lab report
docker compose -f infra/compose/wallet-adapters.compose.yml down -v
```

Use `--sender cdk` to exercise the Rust wallet implementation. The stack is ephemeral and test-only: sender reservations, the local Nostr relay, and receiver evidence stores are reset through the adapter and compose lifecycle.

## Current coverage

| Area                                       | Developer-preview evidence                                                                                       | Release gap                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| HTTP retry, response loss, and duplication | Real-mint T1 lane with cashu-ts/CDK senders plus the reference receiver; cashu-ts also has its own receiver path | Independent wallet receiver and durable sender state  |
| Funded NIP-17 Nostr delivery               | cashu-ts sender/receiver E2E over the repo's real WebSocket relay                                                | Public relay hardening and broader wallet coverage    |
| Durable receiver evidence                  | cashu-ts receiver can use PostgreSQL T3 credit/proof evidence                                                    | Named crash-boundary suite for external wallet pairs  |
| NIP-17 and cross-transport convergence     | Packaged synthetic T0 lanes                                                                                      | Funded wallets and real relay                         |
| Receiver persistence and recovery          | PostgreSQL tests cover prepared recovery, ambiguous mint response, atomic credit, and concurrent-worker leasing  | Every named process-crash boundary                    |
| Delay and reorder                          | HTTP gateway and Nostr relay component tests                                                                     | Packaged end-to-end lanes with injected clock         |
| Sender restart                             | Durable state/reservation ports and terminal-state reconciliation                                                | Bundled durable sender-store adapter and restart lane |

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
