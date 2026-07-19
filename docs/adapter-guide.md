# Adapter guide

An adapter gives the lab one control surface for a wallet or service. Keep wallet code behind the adapter. Do not reimplement its Cashu behavior inside the runner.

## Contract

Serve these routes on loopback unless your test network provides equivalent isolation:

| Method | Route                | Purpose                                                                    |
| ------ | -------------------- | -------------------------------------------------------------------------- |
| `GET`  | `/v1/capabilities`   | Declare implementation, profiles, encodings, transports, and evidence tier |
| `POST` | `/v1/reset`          | Reset deterministic test state from a seed                                 |
| `POST` | `/v1/requests`       | Create a payment request                                                   |
| `POST` | `/v1/send`           | Send or resume one logical payment                                         |
| `GET`  | `/v1/deliveries/:id` | Read the current receipt                                                   |
| `GET`  | `/v1/ledger`         | Return allowlisted merchant credit evidence                                |
| `GET`  | `/v1/proofs`         | Return proof-state hashes and states                                       |

Use `spec/schemas/adapter-capabilities.schema.json` and the request and response types from `@cashu-fault-lab/adapter-contract`. Require a bearer control token outside explicit test mode. Do not place that token in reports.

## Evidence tiers

| Tier | Required evidence                                   |
| ---- | --------------------------------------------------- |
| T0   | Decode and encode pinned public vectors             |
| T1   | Send and receive through one declared transport     |
| T2   | Prove acquisition or recovery of replacement proofs |
| T3   | Prove one durable merchant-ledger credit            |

These tiers follow the canonical definitions in the [design](superpowers/specs/2026-07-19-cashu-fault-lab-design.md#34-evidence-tiers). Fault classes and real-mint execution are scenario requirements, not alternate meanings for an evidence tier.

Declare each profile by role. Return HTTP `501` with `{ "status": "N/A", "reason": "..." }` when the adapter lacks funded wallet state or a profile. A matrix skips that pair. Do not return synthetic success.

## Retry rules

Create one delivery ID and reserve one proof set. Persist both before transport. Retries reuse the exact inner payload bytes. HTTP redirects stay disabled. HTTP relay or Nostr relay acceptance does not settle a payment; only a verified receiver receipt can settle sender state.

A receiver binds a delivery ID to one payload hash. It rejects another payload under that ID before proof consumption. It also rejects the same proof set under another delivery ID without returning proof ownership details.

### Sender state locking

Treat `SenderState.withDeliveryLock` as a durable, per-delivery correctness boundary. Its lock must serialize every client and process that shares sender state for the callback's full lifetime, and the callback's scoped `get`, `create`, and `save` operations must use that same lock or database session. Reject nested lock acquisition. A process-local mutex, including `InMemorySenderState`, is suitable only for tests and single-process development.

## Nostr

NUT-18 conformance needs a `creqA` request with an `nprofile` target and `["n", "17"]`. NIP-17 delivery uses a kind 14 rumor, kind 13 seal, and kind 1059 gift wrap with NIP-44 encryption. Verify each signature, the seal and rumor pubkey match, and the receiver `p` tag.

Create a fresh wrapper key and randomized timestamp for each retry. Keep inner payment bytes fixed. Query overlapping two-day windows so randomized timestamps and relay outages do not hide accepted payments.

Treat the pinned NUT-26 NIP-04/raw-key mapping as a separate expected-failure profile.

## Reports and secrets

Expose hashes, status, amount, unit, and stable error codes. Keep proof secrets, signatures, witnesses, blinded messages, blinding factors, complete payloads, private keys, and bearer values out of adapter logs and responses.

## Local checks

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lab matrix --profile legacy-nut18
pnpm lab matrix --profile delivery-v1
pnpm lab matrix --profile nut26-nostr
```

Rust adapters also run:

```bash
cargo fmt --manifest-path adapters/cdk/Cargo.toml --check
cargo clippy --manifest-path adapters/cdk/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path adapters/cdk/Cargo.toml
```

Copy `adapters/template/README.md` into a new adapter directory, then replace each checklist item with executable contract tests.
