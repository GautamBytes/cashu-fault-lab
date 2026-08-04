# Wallet lifecycle lab

The wallet lifecycle suite is an experimental, opt-in control plane for testing what happens when a
Cashu wallet loses certainty around a mint operation. It lives in this repository because it reuses
the same fault injection, deterministic replay, implementation identity, and independent-evidence
principles as delivery testing. It does not change the existing `cashu-delivery-v1` contract or its
release gate.

## Current implementation

The repository provides the lifecycle identity/state model, language-neutral schemas and HTTP
client, an implementation-independent value-conservation oracle, a seeded runner with redacted
failure artifacts, and restart-safe cashu-ts and CDK adapters.

The cashu-ts adapter implements `mint`, `swap`, `send`, `receive`, `restore`, `reconcile`, and
`melt` when an independent Lightning settlement probe is configured. The CDK preview adapter exposes
restart-safe `mint`, `swap`, `send`, `receive`, `restore`, `reconcile`, and native `melt` recovery
when durable encrypted SQLite state and the same settlement probe authority are configured. Runtime
capability discovery removes operations whose required NUTs are absent at the configured mint.

The developer-preview workflow includes the semantic mint-fault corpus, `lifecycle run`,
`lifecycle matrix`, and `lifecycle replay`. The funded matrix runs cashu-ts and CDK against pinned
Nutshell and mintd images. The opt-in Lightning lane runs a real response-loss melt through pinned
Bitcoin Core, two authenticated LND nodes, and a Nutshell LND backend. Unsupported lanes still
report `N/A` and never count as passes.

Run the Docker-backed suites only on a disposable development host:

```bash
pnpm test:lifecycle:funded
pnpm test:lifecycle:regtest
```

Both commands remove their named Compose volumes before and after the run. The funded suite runs
`mint`, `swap`, `send`, `receive`, `restore`, and `reconcile` across all four wallet/mint
combinations twice from clean state, with one adapter restart preservation check per lane. It does
not claim funded `melt` coverage or a full mint/adapter crash-boundary matrix. The regtest suite
opens a balanced local channel, loses the committed melt response, restarts the adapter, resumes
concurrently, and checks the sink and payer independently for exactly one settlement and conserved
NUT-08 change.

## Run a lifecycle scenario

Configure loopback adapter and gateway endpoints. Keep control tokens out of command arguments and
report files.

```bash
export CFL_LIFECYCLE_CASHU_TS_URL=http://127.0.0.1:4101
export CFL_LIFECYCLE_CASHU_TS_TOKEN='<adapter control token>'
export CFL_HTTP_FAULT_GATEWAY_URL=http://127.0.0.1:4300
export CFL_HTTP_FAULT_GATEWAY_TOKEN='<gateway control token>'

pnpm lab doctor --suite lifecycle
pnpm lab lifecycle run mint-response-lost \
  --adapter cashu-ts \
  --mint nutshell-local \
  --seed local-seed
```

The default report path is `artifacts/lifecycle/<scenario>.json`. Reports contain a
domain-separated seed hash and sanitized operation evidence. Use these forms for other outputs:

```bash
pnpm lab lifecycle run swap-response-lost --adapter cashu-ts --mint nutshell-local \
  --seed local-seed --format junit --output artifacts/lifecycle/swap.xml
pnpm lab lifecycle matrix --profile wallet-lifecycle-v1 --json
pnpm lab lifecycle replay artifacts/lifecycle/failure.json \
  --seed local-seed --adapter cashu-ts --mint nutshell-local
```

## State and recovery model

Every operation has a caller-generated 128-bit base64url ID and an immutable identity:

```text
operationId + kind + canonical mint URL + unit + intentHash
```

The adapter persists identity and encrypted prepared request material before a request that can
create an economic effect. Successful requests may finish immediately. Any terminal failure after
submission must pass through ambiguity and reconciliation:

```text
created -> prepared -> submitted -> succeeded
                              \-> ambiguous -> reconciling -> succeeded
                                                       \-> failed_definitive
                                                       \-> recovery_blocked
```

Timeouts, disconnects, malformed responses, and crashes are ambiguous. `failed_definitive` requires
stable evidence such as an unpaid quote or unspent inputs. If available evidence cannot prove a safe
outcome, the adapter returns `recovery_blocked` instead of retrying blindly.

The runner checks value conservation and idempotent effects independently of cashu-ts. Failure
artifacts contain a domain-separated seed hash, never the raw wallet seed. Replay and minimization
require the original seed out of band and verify it against that hash. Tokens and invoices are also
redacted; secret-bearing scenarios require their inputs to be restored by a trusted harness.

## Lifecycle HTTP surface

The lifecycle routes are registered only when the durable lifecycle database and encryption key are
configured. They use the adapter's existing bearer control token.

| Method | Route                                          | Purpose                             |
| ------ | ---------------------------------------------- | ----------------------------------- |
| `GET`  | `/v1/lifecycle/capabilities`                   | Discover executable operations/NUTs |
| `POST` | `/v1/lifecycle/reset`                          | Reset deterministic test state      |
| `POST` | `/v1/lifecycle/operations`                     | Start one immutable operation       |
| `POST` | `/v1/lifecycle/operations/:operationId/resume` | Reconcile an existing operation     |
| `GET`  | `/v1/lifecycle/operations/:operationId`        | Read sanitized operation state      |
| `GET`  | `/v1/lifecycle/wallet`                         | Read balances and hashed proof IDs  |
| `GET`  | `/v1/lifecycle/evidence`                       | Read ordered sanitized evidence     |

The resume identity is canonical in the path. A bodyless request follows the OpenAPI contract; an
optional `{ "operationId": "..." }` echo remains accepted for compatibility and must match the
path.

## Configure cashu-ts

Lifecycle mode requires these variables in addition to the normal funded cashu-ts adapter values:

```bash
export CFL_CASHU_TS_LIFECYCLE_DATABASE_URL=postgres://cashu:cashu@127.0.0.1:5432/cashu_fault_lab
export CFL_CASHU_TS_LIFECYCLE_STATE_KEY='<32-byte base64url key>'
export CFL_CASHU_TS_LIFECYCLE_RUN_ID=local-lifecycle-run
```

Optional variables are:

- `CFL_CASHU_TS_LIFECYCLE_TENANT_ID` for database isolation.
- `CFL_CASHU_TS_LIFECYCLE_ALLOW_UNSAFE_MINT=true` to permit an explicitly configured external
  HTTPS mint. HTTP is limited to loopback.
- `CFL_CASHU_TS_LIFECYCLE_LIGHTNING_PROBE_URL` and
  `CFL_CASHU_TS_LIFECYCLE_LIGHTNING_PROBE_TOKEN` together to enable melt verification.
- `CFL_CASHU_TS_LIFECYCLE_ALLOW_UNSAFE_LIGHTNING_PROBE=true` to permit an external HTTPS probe.

The read-only probe receives `{invoice, invoiceHash, quoteHash}` and must return
`{settled:true, invoiceHash, quoteHash}` with exact bindings. It uses a bearer token, forbids
redirects, has a five-second timeout, and bounds responses to 8 KiB. Probe failure keeps the melt
recovery-blocked. An unverified PAID quote is never treated as independent Lightning evidence.

## Security and deployment rules

- Use only isolated regtest mints and Lightning nodes. Never point automated lifecycle tests at
  mainnet, public testnet, real funds, or a public mint.
- Keep the adapter bound to loopback unless it is inside an authenticated isolated test network.
- Generate a unique 32-byte state key and keep it outside manifests, reports, and source control.
- Treat PostgreSQL as correctness-critical: the operation journal, proof reservations, evidence,
  and send outbox commit atomically.
- Consume send handoffs through the trusted internal claim/ack outbox API. Lifecycle HTTP responses
  never expose the generated Cashu token.
- Mint calls are same-origin, never follow redirects, omit credentials/referrers, time out, and cap
  streamed responses at 1 MiB.
- Development source/build digests are deterministic fixture identities, not release provenance.

## Release qualification

`spec/lifecycle-release-suite.json` is the strict `wallet-lifecycle-v1` qualification policy. Its
digest binds the complete required operation, scenario, invariant, and provenance requirements.
The evaluator rejects malformed or contradictory evidence, duplicate participants, skipped
required scenarios, missing replay digests, failed artifact secret scans, fewer than two independent
wallet languages, fewer than two mint implementations, or adapter-claimed invariant evidence.
Repository fixtures use development identities, so passing local tests is strong implementation
evidence but is not an external certification claim. See the
[v0.2.0 maintainer-preview checklist](releases/v0.2.0-checklist.md).

The normative contract is [the lifecycle OpenAPI document](../spec/lifecycle-openapi.yaml).
