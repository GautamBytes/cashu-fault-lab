# NIP-60 wallet doctor

The wallet doctor suite is an experimental, opt-in diagnostic lane for NIP-60 Cashu wallets. It
collects one subject's wallet events from several Nostr relays, reconstructs the wallet the way
three different readers would see it, verifies every discovered proof against its mint, explains
exactly why two applications disagree about a balance, and emits a deterministic **dry-run** repair
plan. It lives in this repository because it reuses the same fault injection, deterministic
replay, redacted-evidence, and independent-oracle principles as delivery and lifecycle testing.
It does not change the `cashu-delivery-v1` or `wallet-lifecycle-v1` contracts or their release
gates, and its output is diagnostic evidence, not certification.

Read [ADR 002](adrs/002-nip60-wallet-doctor.md) for the safety boundary. The doctor never
publishes events and never moves value. Proof secrets are dropped at capture time; artifacts carry
only each proof's public NUT-00 `Y` (the value a wallet already sends to a mint in NUT-07 state
checks). The NIP-60 wallet `privkey` inside `kind:17375` is never read or stored.

## Current implementation

The repository provides the pure reconstruction model, the capture pipeline (read-only relay
fetch, NIP-44 decryption, NUT-07 checkstate), an independent diagnosis oracle with nine stable
codes, a repair planner with safety invariants, a lab reference wallet fixture, relay-side history
partitions on the Nostr fault relay, seeded scenarios with replay, a funded Docker lane, and the
CLI surface.

Diagnosis codes emitted today: `RELAY_PARTITION`, `GHOST_TOKEN`, `ORPHANED_PROOFS`,
`DEL_CHAIN_BREAK`, `WALLET_EVENT_FORK`, `DELETION_NOT_PROPAGATED`, `HISTORY_GAP`, `QUOTE_LIMBO`,
and `MALFORMED_EVENT`. Every code maps a user symptom ("sats missing", "sats counted twice",
"wallet not recognized") to relay/mint evidence. See
[the profile document](../spec/nip60-doctor-v1.md) for the reconstruction rules.

## Diagnose a wallet from relays

Collection is read-only and runs on the operator's own machine. The subject key comes from an
environment variable, never from command arguments:

```bash
export CFL_NIP60_SUBJECT_KEY='nsec1… or 64-hex test key'

pnpm lab wallet-doctor collect \
  --relay ws://127.0.0.1:4430 --relay ws://127.0.0.1:4431 \
  --output artifacts/wallet-doctor/capture.json

pnpm lab wallet-doctor diagnose artifacts/wallet-doctor/capture.json
pnpm lab wallet-doctor plan artifacts/wallet-doctor/capture.json
pnpm lab wallet-doctor check artifacts/wallet-doctor/capture.json
```

`diagnose` prints the three balances (per-relay, naive merged, mint-verified) and every finding.
`plan` prints the repair steps with their safety-invariant outcome and writes a plan artifact;
nothing is published. `check` is the CI gate: it exits non-zero on any error finding and on any
plan-safety violation. Keyless evidence gathering is possible with `--pubkey <hex>` (encrypted
events are then reported as `decryption_failed` malformed entries).

External wallet teams can produce the documented capture bundle in their own CI and run
`npx cashu-fault-lab@0.1.4 wallet-doctor check <capture>`; the bundle format is the interop contract
(`spec/schemas/nip60-capture.schema.json`). The gate fails on any error-severity finding, any
unreachable relay in the capture, or an unsafe repair plan.

## Run the scenario lane

Seeded scenarios drive the lab reference wallet fixture against two Nostr fault relays and a
real mint. They require the funded stack:

```bash
export CFL_WALLET_DOCTOR_FIXTURE_URL=http://127.0.0.1:4500
export CFL_WALLET_DOCTOR_FIXTURE_TOKEN='<fixture control token>'
export CFL_WALLET_DOCTOR_RELAYS=ws://127.0.0.1:4430,ws://127.0.0.1:4431
export CFL_WALLET_DOCTOR_RELAY_CONTROLS=http://127.0.0.1:4440,http://127.0.0.1:4441
export CFL_WALLET_DOCTOR_RELAY_CONTROL_TOKEN='<relay control token>'

pnpm lab wallet-doctor run del-chain-break --seed demo
pnpm lab wallet-doctor matrix --profile nip60-doctor-v1 --json
pnpm lab wallet-doctor replay artifacts/wallet-doctor/del-chain-break.json --seed demo
```

Each run writes `artifacts/wallet-doctor/<scenario>.json` (mode `0600`) with the expected and
actual diagnosis codes, the balance explanation, the capture digest, and a domain-separated seed
hash. Replay re-executes the scenario with the original seed and verifies the same codes and
balances; event ids and proof `y` values are fresh on every execution and intentionally not
compared.

The funded lane brings the whole stack up and down around the run (pinned Nutshell mint, two
fault relays with HTTP fault control, the reference fixture). Run it only on a disposable
development host:

```bash
pnpm test:doctor:funded
```

Compose sets `CFL_NIP60_FIXTURE_MINT` to the docker-internal mint URL for cashu-ts ops and
`CFL_NIP60_FIXTURE_PUBLIC_MINT` to the host-published alias (`http://127.0.0.1:3348` by default).
The fixture publishes the public URL into NIP-60 payloads so host-side captures can reach the mint
for NUT-07 checkstate.

A Docker-free golden lane runs the same packaged scenarios in-process with a fake mint in the
unit tier (`packages/wallet-doctor-runner/test/scenario.test.ts`); the funded lane re-proves them
with real mint interactions.

## Scenario format

Scenarios live in `scenarios/wallet-doctor/*.json`. Steps are `mint`, `spend` (with a publish
fault mode: `clean`, `partial-delete`, `partial-publish`, `ghost`, `delete-only`), and
`relay-partition`/`relay-heal` (relay-side history loss via the fault relay's partition control).
Expectations pin the exact diagnosis codes and the balance explanation:

```json
{
  "schemaVersion": 1,
  "id": "del-chain-break",
  "name": "Del-chain break across two relays",
  "description": "…",
  "commands": [
    { "op": "mint", "amount": 16 },
    { "op": "spend", "amount": 4, "mode": "partial-delete" }
  ],
  "expect": { "codes": ["DEL_CHAIN_BREAK"], "ok": false }
}
```

## Reference fixture

`apps/nip60-reference-wallet` is a lab-only minimal NIP-60 wallet: it mints and spends real
proofs with cashu-ts and publishes wallet/token/deletion events to configurable relays, with
deliberate publish-fault modes that reproduce the ways real wallets diverge. Loopback and bearer
token only; the `/v1/doctor-wallet/subject` route exposes the generated test key to the harness.
It is a test fixture, never a real wallet, and it intentionally keeps state in memory because
crash recovery belongs to the lifecycle suite.

## Relay fault control

The Nostr fault relay now persists partitions (relay-side history loss) alongside its counted
rules. When `CFL_NOSTR_FAULT_RELAY_TOKEN` is set, the relay also serves an HTTP control surface:

| Method   | Route                  | Purpose                                  |
| -------- | ---------------------- | ---------------------------------------- |
| `GET`    | `/v1/faults/evidence`  | Snapshot of rules, partition, and counts |
| `POST`   | `/v1/faults/rules`     | Arm a counted fault rule                 |
| `POST`   | `/v1/faults/partition` | Withhold matching events from history    |
| `DELETE` | `/v1/faults`           | Clear rules and the partition            |
| `POST`   | `/v1/faults/reset`     | Clear faults **and all stored events**   |

## Remaining work

- Repair-plan **execution** (publishing) is out of scope for v1 by design; see ADR 002.
- NIP-61 nutzap redemption is recognized in history markers only.
- The funded lane covers the reference fixture; independent wallet implementations plug in through
  the capture bundle and the `check` CI gate.
- The doctor is not part of release qualification; the delivery release gate remains blocked and
  untouched.
