# NIP-60 Wallet Doctor and Interop Suite Design

**Date:** 2026-08-03
**Status:** Draft for review
**Supersedes:** the "NIP-60 relay diagnosis, repair, or wallet-event reconciliation" exclusion in
[2026-08-01-wallet-lifecycle-lab-design.md](./2026-08-01-wallet-lifecycle-lab-design.md) (that
exclusion scoped the lifecycle suite, not the repository; this document scopes a separate suite)

## 1. Outcome

Cashu Fault Lab gains a `nip60-doctor-v1` suite that collects a user's NIP-60 wallet events from
several Nostr relays, reconstructs the wallet state each application would see, verifies every
proof against its Cashu mint, explains exactly why two applications disagree about a balance, and
emits a deterministic, dry-run repair plan. The same machinery provides a CI interop kit that
external wallet developers run against their own relay captures.

The suite never moves value and never publishes events by default. Collection is read-only; repair
produces a plan artifact. Plan execution is out of scope for v1.

## 2. Protocol baseline

Pinned `nostr_nips` commit `bdfa7e62ef87fcfcb992b1a27aee49d36b0b4f91` in
`spec/upstream-lock.json` already contains the current NIP-60 text (verified byte-identical to
master on 2026-08-03). No re-pin is required; only `checked_at` is refreshed.

In scope from the pinned text:

- `kind:17375` replaceable wallet event (NIP-44-encrypted `privkey`/`mint` tags).
- `kind:7375` token events (encrypted `{mint, unit, proofs, del}`).
- NIP-09 `kind:5` deletions with the mandatory `["k", "7375"]` tag.
- `kind:7376` spending-history events (`created`/`destroyed`/`redeemed` markers; encrypted tags).
- `kind:7374` quote events with NIP-40 expiration (diagnostic only).
- NIP-44 v2 decryption, NIP-01 filters `{kinds: [17375, 7375, 7376, 7374, 5], authors: [pk]}`.
- Relay-set discovery: `kind:10019` first, NIP-65 fallback.

Out of scope for v1: NIP-61 nutzap handling beyond recognizing `redeemed` markers, repair
execution, mainnet/public-relay credentials in CI, and any new NIP/NUT proposal.

## 3. Why this lives in the monorepo

The suite reuses only genuinely common infrastructure, per the lifecycle precedent: adapter
discovery, authenticated control APIs, fault injection, deterministic seeded histories, replay,
redacted reports, Docker fixtures, and CI. It does not import delivery-core or
wallet-lifecycle-core state models. The oracle consumes only normalized observations and never
imports a wallet library, relay client, or mint client implementation.

## 4. Core model: three reconstructions and a diff

The doctor reconstructs one logical wallet three ways and diffs them:

1. **Per-relay view** — the state an application sees reading only relay R: live token events
   (not NIP-09-deleted on R), the replaceable wallet event R serves, and the proof set implied by
   walking `del` chains from live events.
2. **Merged view** — union over all relays with NIP-09 deletion sets and `del`-chain semantics
   applied. This is where naive wallets double-count: a spent token event still live on relay B
   and its rollover live on relay A sum the same sats twice.
3. **Mint-verified truth** — for every proof seen anywhere, NUT-07 `POST /v1/checkstate` on the
   owning mint classifies it `UNSPENT`/`SPENT`/`PENDING`; NUT-09 restore covers proofs no live
   event references.

Every divergence between the three views maps to a stable diagnosis code:

| Code                      | Meaning                                                                                       | User symptom                         |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| `RELAY_PARTITION`         | A token event exists on a strict subset of relays                                             | Balance differs between apps         |
| `GHOST_TOKEN`             | Live token event whose proofs are all `SPENT` at the mint                                     | App shows sats that are gone         |
| `ORPHANED_PROOFS`         | Proofs `UNSPENT` at mint but referenced by no live event (deletion propagated, rollover lost) | Sats missing, recoverable via NUT-09 |
| `DEL_CHAIN_BREAK`         | A `del`-referenced predecessor is still live on some relay                                    | Double-counted balance               |
| `WALLET_EVENT_FORK`       | Relays serve conflicting `kind:17375` replacements (different mint sets/keys)                 | App fails to recognize the wallet    |
| `DELETION_NOT_PROPAGATED` | `kind:5` exists on relay A; the target is still served by relay B                             | Flapping balance across apps         |
| `HISTORY_GAP`             | `kind:7376` entries inconsistent with token transitions                                       | Wrong/missing transaction history    |
| `QUOTE_LIMBO`             | `kind:7374` quote neither paid nor expired per mint                                           | Pending mint that never completes    |
| `MALFORMED_EVENT`         | Undecryptable or schema-invalid content                                                       | App ignores state silently           |

## 5. Packages

```text
packages/
  wallet-doctor-core/       Pure model: event identity, per-relay/merged reconstruction,
                            del-chain graph, diagnosis rules, repair-plan model. No I/O,
                            no cashu-ts, no nostr-tools. Crypto via injected interfaces.
  wallet-doctor-contract/   Language-neutral schemas + HTTP client for the two sources
                            (relay capture, mint checkstate) and the wallet-fixture contract.
  wallet-doctor-oracle/     Independent verifier: rebuilds state from raw captures + mint
                            truth, emits diagnosis codes, checks repair-plan safety/idempotence.
  wallet-doctor-runner/     Seeded scenarios, replay, redacted artifacts, JSON/JUnit/HTML reports.
scenarios/
  wallet-doctor/            relay-partition, ghost-token, orphaned-proofs, del-chain-break,
                            wallet-event-fork, deletion-not-propagated, multi-mint-mixed,
                            history-gap, quote-limbo
apps/
  nip60-reference-wallet/   Minimal funded NIP-60 wallet fixture (cashu-ts for mint ops,
                            nostr-tools for events) with durable state, crash-arm routes,
                            and deliberate partial-publish behaviors for scenario injection.
```

Dependency rules mirror lifecycle: runner -> contract -> core; oracle -> core only; apps depend
on contract, never on oracle.

## 6. Sources (ports)

- **Relay capture source.** Read-only Nostr client over `ws` (nostr-tools 2.23.12, already used by
  `apps/nostr-fault-relay`). Fetches the kind filter above plus `#k=7375` deletions per relay,
  storing raw signed events per relay in a versioned capture bundle. Capture performs no writes.
- **Mint truth source.** NUT-07 checkstate batches per mint, mint info and keyset snapshots for
  evidence. Read-only.
- **Wallet fixture (lab only).** `apps/nip60-reference-wallet` exposes an HTTP control contract
  (capabilities, reset, mint/spend/publish operations, crash-arm, per-relay publish selectors)
  following the eight-route adapter pattern and loopback/token conventions.

## 7. Repair plan (dry-run)

`wallet-doctor plan` consumes a diagnosis and emits a deterministic, content-hashed plan artifact:

1. Republish missing token events to relays that lack them (`RELAY_PARTITION`,
   `DELETION_NOT_PROPAGATED`).
2. Publish a consolidating rollover token event covering exactly the mint-verified `UNSPENT`
   proofs, with a complete `del` set (`GHOST_TOKEN`, `DEL_CHAIN_BREAK`).
3. Publish NIP-09 deletions with `["k", "7375"]` for every superseded/spent token event.
4. Republish the newest `kind:17375` to lagging relays (`WALLET_EVENT_FORK`).
5. Emit wallet-action instructions for `ORPHANED_PROOFS` (NUT-09 restore must be performed by a
   wallet holding the secrets; the doctor never does it).

Plan safety invariants checked by the oracle: a plan never deletes an event referencing a proof
the mint reports `UNSPENT` without a rollover covering it (P1); applying a plan twice yields the
same resulting state (P2); plan steps reference only events present in the capture (P3). The plan
is a signed-by-schema artifact, not a transaction — nothing is published.

## 8. Fault injection and fixtures

- Run three `nostr-fault-relay` instances (loopback 4430-4432) as independent relays. Add one
  control route to the existing relay app: `POST /v1/faults/history-partition` programming which
  stored events a relay serves per author/kind filter (complements existing `duplicate_publish`,
  `drop_ok`, `delay_history`, `reorder_history`, `disconnect`).
- `infra/compose/wallet-doctor.compose.yml`: three relay instances, pinned Nutshell 0.20.2 and
  mintd 0.17.3, the reference wallet fixture, postgres for fixture durability. Digest-pinned
  images, `127.0.0.1` publishes, `:?` mandatory token interpolation, per existing convention.
- New migration `infra/migrations/009_wallet_doctor_fixture.sql` only if the fixture needs
  durable crash-state (AES-256-GCM columns, tenant/run scoping, per 006-008 pattern).

## 9. CLI

`doctor` is taken (environment readiness). New subtree, registered in
`apps/lab-cli/src/command-registry.ts` with implementation in `apps/lab-cli/src/commands/wallet-doctor.ts`:

```text
cashu-fault-lab wallet-doctor collect --relays ws://... [--nsec-env VAR] --output capture.json
cashu-fault-lab wallet-doctor diagnose <capture> [--format json|junit|html]
cashu-fault-lab wallet-doctor plan <capture> --output plan.json
cashu-fault-lab wallet-doctor check <capture>          # CI kit: exit code + invariant summary
cashu-fault-lab wallet-doctor run <scenario> --seed s
cashu-fault-lab wallet-doctor matrix --profile nip60-doctor-v1
cashu-fault-lab wallet-doctor replay <artifact> --seed s
```

Keys come from env vars, never CLI args; decrypted proofs are never written to artifacts (only
hashed proof IDs); artifacts keep `0600`/`0700` modes and the existing Bearer/`nsec1`/`cashu`
redaction in `safeError`. Regenerate `docs/cli-reference.md` (`pnpm docs:cli:check` gates CI).

## 10. Spec, evidence, and release posture

- `spec/nip60-doctor-v1.md` — the diagnostic profile document (conformance boundary: diagnosis,
  not certification).
- New schemas: `nip60-capture.schema.json`, `nip60-diagnosis.schema.json`,
  `nip60-repair-plan.schema.json`, wallet-fixture contract schemas; extend codegen batch so
  TS/Rust/Python projections stay deterministic (`pnpm codegen:check`).
- `spec/vectors/nip60-*.json` — canonical encrypted event chains built with published lab keys so
  external developers can byte-compare decryptions and reconstructions.
- `spec/nip60-doctor-release-suite.json` — own profile, own digest, `allowSkippedRequired: false`;
  diagnostic only. The delivery `release-policy.json` gate stays blocked and untouched.
- Refresh `checked_at` in `spec/upstream-lock.json`.
- ADR 002 records the scope decision and the read-only/dry-run boundary.

## 11. CI interop kit (for external wallet developers)

- The capture bundle is the interop contract: any wallet's CI collects events from its own test
  relays into the documented JSON format and runs `npx cashu-fault-lab wallet-doctor check
<capture>` for a pass/fail invariant report (JSON/JUnit).
- Ship `scenarios/wallet-doctor/`, new schemas, vectors, and the doctor compose in the npm
  package (extend `apps/npm-cli/scripts/build.mjs` runtime copies + `scripts/npm-package.test.mjs`
  assertions).
- `docs/wallet-doctor.md` documents the capture format, diagnosis codes, and CI integration;
  register it in `apps/website/lib/content-registry.ts` (scenarios under
  `scenarios/wallet-doctor/` are auto-discovered by the site).

## 12. Meta-test and tooling tax (non-negotiable repo convention)

- `scripts/release-metadata.test.mjs`: four new `0.1.0` private workspace packages.
- `scripts/test-tiers.test.mjs`: unit-exclusion list + new tier script shape.
- `scripts/test-environment.mjs`: new `doctor-funded` mode owning compose lifecycle.
- Root `package.json`: `test:doctor:funded`; CI job in `ci.yml`, heavier seeds in `nightly.yml`.
- `scripts/docker-context.test.mjs` / `.dockerignore` if the fixture adds build context.
- Website tests covering the registry entry.

## 13. Phasing

| Phase | Deliverable                                                         | Gate                              |
| ----- | ------------------------------------------------------------------- | --------------------------------- |
| 0     | This doc, ADR 002, upstream-lock `checked_at` refresh               | docs review                       |
| 1     | wallet-doctor-core + schemas + vectors (pure, unit-tested)          | `pnpm test`                       |
| 2     | Relay capture + mint truth sources, capture bundle format           | unit + integration                |
| 3     | Oracle: three reconstructions, nine diagnosis codes, reports        | unit + golden vectors             |
| 4     | Repair planner + P1-P3 safety invariants                            | unit + property tests             |
| 5     | nip60-reference-wallet fixture + relay history-partition fault      | integration                       |
| 6     | Runner, CLI subtree, replay, matrix profile                         | `pnpm test` + codegen/docs checks |
| 7     | Compose stack, `test:doctor:funded` tier, CI job                    | CI green                          |
| 8     | Interop kit: `check` command, external capture docs, npm bundling   | npm-package tests                 |
| 9     | Website registry, CHANGELOG, release notes (version per maintainer) | release checklist                 |

## 14. Explicit non-goals for v1

- Executing repair plans against live relays.
- Holding or deriving the NIP-60 wallet `privkey` (P2PK key) — the doctor needs only the user's
  Nostr key to decrypt event content, and only inside lab fixtures or the user's own machine.
- NIP-61 nutzap redemption testing (recognized in history markers only).
- Treating doctor output as release qualification for any wallet.
