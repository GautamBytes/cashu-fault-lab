# Cashu Fault Lab

Cashu Fault Lab checks payment delivery across retries, duplicates, transport loss, and receiver restart. It proves one logical payment creates one receiver settlement plan and one merchant credit.

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

pnpm lab run scenarios/crash-recovery/all-failpoints.json --seed crash-demo
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

`delivery-v1` runs supported receipt and idempotency pairs. `legacy-nut18` checks pinned `creqA` codec vectors. `nut26-nostr` reports the pinned NIP-04/raw-key versus NIP-17/`nprofile` mismatch as an expected failure.

The bundled cashu-ts and CDK adapters claim T0 codec evidence. They return `N/A` for funded operations until you inject wallet or receiver implementations. The reference TypeScript pair provides T3 fault and settlement evidence.

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
- `apps/reference-sender`: durable reservation and retry state
- `apps/reference-receiver`: transactional settlement, PostgreSQL, and recovery
- `packages/scenario-runner`: virtual scheduler, oracle feed, fault lanes, and replay
- `apps/http-fault-gateway` and `apps/nostr-fault-relay`: semantic transport faults
- `adapters`: cashu-ts, CDK, and adapter template
- `spec`: schemas, public vectors, invariants, and protocol lock

Read [adapter guide](docs/adapter-guide.md) before adding another wallet implementation.
