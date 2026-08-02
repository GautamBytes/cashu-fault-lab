# Adapter guide

An adapter gives the lab one control surface for a wallet or service. Keep wallet code behind the adapter. Do not reimplement its Cashu behavior inside the runner.

## Contract

Version 0.1.3 accepts these routes only on loopback origins
(`http://127.0.0.1:<port>` or `http://[::1]:<port>`):

| Method | Route                | Purpose                                                              |
| ------ | -------------------- | -------------------------------------------------------------------- |
| `GET`  | `/v1/capabilities`   | Declare versioned implementation identity and role-specific evidence |
| `POST` | `/v1/reset`          | Reset deterministic test state from a seed                           |
| `POST` | `/v1/requests`       | Create a payment request                                             |
| `POST` | `/v1/send`           | Send or resume one logical payment                                   |
| `GET`  | `/v1/deliveries/:id` | Read the current receipt                                             |
| `GET`  | `/v1/ledger`         | Return allowlisted merchant credit evidence                          |
| `GET`  | `/v1/proofs`         | Return proof-state hashes and states                                 |
| `GET`  | `/v1/redemptions`    | Return cumulative mint redemption-start evidence                     |

Use `spec/schemas/adapter-capabilities.schema.json` and the request and response types from `@cashu-fault-lab/adapter-contract`. Require a bearer control token outside explicit test mode. Do not place that token in reports.

### Optional wallet lifecycle extension

Wallet lifecycle testing uses a separate `/v1/lifecycle/*` contract so adding it cannot change
existing delivery behavior. Implementations that do not support it keep serving the delivery routes
above without modification. Implementations that opt in should use
`spec/lifecycle-openapi.yaml`, `@cashu-fault-lab/wallet-lifecycle-contract`, and the rules in the
[wallet lifecycle guide](wallet-lifecycle.md).

Advertise only operations that are executable with the current mint and configured evidence
authorities. In particular, a wallet must not advertise `melt` merely because the mint supports
NUT-05: successful melt evidence also needs an independent Lightning settlement probe. Accept the
operation identity from the resume route path; accepting the older matching body echo is a
compatibility extension, not a second source of identity.

## Evidence tiers

| Tier | Required evidence                                   |
| ---- | --------------------------------------------------- |
| T0   | Decode and encode pinned public vectors             |
| T1   | Send and receive through one declared transport     |
| T2   | Prove acquisition or recovery of replacement proofs |
| T3   | Prove one durable merchant-ledger credit            |

These tiers follow the canonical definitions in the [design](superpowers/specs/2026-07-19-cashu-fault-lab-design.md#34-evidence-tiers). Fault classes and real-mint execution are scenario requirements, not alternate meanings for an evidence tier.

Capability schema v2 requires `schemaVersion`, source/build digests, language/runtime identity,
separate `roles.sender` and `roles.receiver` objects, and configured mint identities. Each role
owns its transports, supported profiles, durability, evidence tier, and evidence sources. Omit an
unsupported role or profile. Return HTTP `501` with `{ "status": "N/A", "reason": "..." }` when
the adapter lacks funded wallet state. A matrix skips that pair. Do not return synthetic success.

Evidence is role-specific. A funded sender can claim T1 after it reserves real proofs, delivers them through its declared transport, and reconciles a receiver receipt. It cannot claim T3: durable merchant credit is receiver-owned evidence and must come from an independently inspectable receiver ledger. Likewise, the bundled reference receiver's T1 evidence does not turn a sender-only cashu-ts or CDK adapter into a receiver implementation.

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

Expose hashes, status, amount, unit, and stable error codes. Keep proof secrets, signatures,
witnesses, blinded messages, blinding factors, complete payloads, wallet seeds, invoices, private
keys, and bearer values out of adapter logs, reports, and responses. Lifecycle replay artifacts
store only a domain-separated seed hash; callers provide the raw seed out of band.

## Maintainer preview

Version 0.1.3 intentionally accepts only adapter and evidence origins on
`http://127.0.0.1:<port>` or `http://[::1]:<port>`. Hosted adapters, TLS termination, redirects,
userinfo, paths, queries, and fragments are rejected. This keeps wallet control tokens and funded
test traffic on the maintainer's machine while the external contract is still experimental.

Start the adapter processes, export the token variables named by `adapter-manifest.json`, and run:

```bash
npx cashu-fault-lab@0.1.3 adapter preflight \
  --adapters adapter-manifest.json

npx cashu-fault-lab@0.1.3 adapter preview \
  --adapters adapter-manifest.json \
  --sender my-wallet \
  --receiver my-wallet \
  --output-dir cashu-fault-results
```

Preflight is read-only: it checks authentication, identity, contract compatibility, profile support,
and configured evidence authorities without resetting wallet state. Preview then runs the exact
selected pair through the response-loss and duplicate-delivery scenarios. It automatically starts
an authenticated loopback fault gateway on port `4300` when no gateway is configured, and always
stops a gateway it started.

The receiver's generated payment request must advertise the gateway origin
(`http://127.0.0.1:4300`) as its HTTP target so the preview can inject transport faults; the gateway
forwards that path to the selected receiver adapter origin. Set `CFL_HTTP_FAULT_GATEWAY_URL` and
`CFL_HTTP_FAULT_GATEWAY_TOKEN` only when reusing an already-running loopback gateway.
When `/v1/requests` receives `httpTarget`, use that value for HTTP transport targets. If it is an
origin without a path, preserve the adapter's normal payment path under that origin.

Share `cashu-fault-results/preview.json` or `preview.html` when opening an issue. The bundle also
contains JUnit, the preflight result, exact per-scenario replay commands, and a short README. It is
redacted developer feedback evidence, not certification or release qualification.

## Local checks

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lab matrix --profile legacy-nut18
pnpm lab matrix --profile delivery-v1
pnpm lab matrix --profile nut26-nostr
pnpm lab matrix --profile delivery-v1 \
  --release-policy spec/release-policy.json \
  --release-suite spec/release-suite.json
```

Rust adapters also run:

```bash
cargo fmt --manifest-path adapters/cdk/Cargo.toml --check
cargo clippy --manifest-path adapters/cdk/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path adapters/cdk/Cargo.toml
```

Run the real recovery and cross-language sender lanes against each started fake-wallet mint:

```bash
CFL_REAL_MINT_URL=http://127.0.0.1:3338 \
  pnpm --filter @cashu-fault-lab/reference-receiver exec vitest run \
  test/docker-mint-e2e.test.ts
CFL_REAL_MINT_URL=http://127.0.0.1:3338 \
  pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run \
  test/cross-language-docker.test.ts
CFL_REAL_MINT_URL=http://127.0.0.1:8085 \
  pnpm --filter @cashu-fault-lab/reference-receiver exec vitest run \
  test/docker-mint-e2e.test.ts
CFL_REAL_MINT_URL=http://127.0.0.1:8085 \
  pnpm --filter @cashu-fault-lab/scenario-runner exec vitest run \
  test/cross-language-docker.test.ts
```

For smoke testing, register each adapter's loopback origin and token environment-variable name in a
schema-version 2 manifest. `spec/examples/adapters.local.json` is the runnable example; bearer values
stay in the environment and out of manifests and reports.

Strict qualification also needs independent read-only evidence authorities. Configure them on a
receiver registration with origins and tokens distinct from the adapter control process:

```json
{
  "schemaVersion": 2,
  "adapters": [
    {
      "id": "wallet-receiver",
      "url": "http://127.0.0.1:4102",
      "tokenEnv": "WALLET_RECEIVER_TOKEN",
      "evidence": {
        "ledger": {
          "url": "http://127.0.0.1:5101",
          "tokenEnv": "LEDGER_EVIDENCE_TOKEN"
        },
        "mint": {
          "url": "http://127.0.0.1:5102",
          "tokenEnv": "MINT_EVIDENCE_TOKEN"
        }
      }
    }
  ]
}
```

The lab uses the ledger authority only for `/v1/ledger` and the mint authority only for
`/v1/proofs` plus `/v1/redemptions`. The redemption response is an array of
`{ deliveryId, proofSetHash, starts }` records; `starts` is a cumulative count capped at 1,000.
This count is required for at-most-once redemption because a final `spent` state cannot reveal how
many mint requests started. Without these authorities, wallet-reported observations remain
`adapter_claimed`: useful for developer diagnostics, but rejected by the checked-in release policy.
HTTP fault qualification similarly requires the runner-controlled gateway to return the exact
configured rule ID, method, path, phase, action, and a positive application count.

Start new standalone adapters with `pnpm lab adapter init --language typescript --name my-wallet --output ./my-wallet`, choosing `typescript`, `rust`, or `python` as needed. The generated project includes contract route tests, a manifest, Dockerfile, health check, and CI example without importing private monorepo packages.
