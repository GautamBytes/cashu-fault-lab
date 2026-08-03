# Changelog

## Unreleased

- Added the NIP-60 wallet doctor suite: multi-relay capture with NIP-44 decryption and NUT-07 mint
  verification, three-way wallet reconstruction (per-relay, merged, mint-verified), nine stable
  diagnosis codes, and deterministic dry-run repair plans with oracle-checked safety invariants.
- Added the `wallet-doctor collect/diagnose/plan/check/run/matrix/replay` CLI surface and the
  versioned capture bundle (`spec/schemas/nip60-capture.schema.json`) as the CI interop contract
  for external wallet teams.
- Added a lab-only reference NIP-60 wallet fixture with deliberate publish-fault modes, seven
  packaged scenarios under `scenarios/wallet-doctor/`, seeded replay, and the funded
  `test:doctor:funded` lane (pinned Nutshell mint, two fault relays, fixture).
- Added persistent history partitions and an authenticated HTTP fault-control surface
  (`/v1/faults/*`, including `/v1/faults/reset`) to the Nostr fault relay.

## 0.1.3 — 2026-08-02

- Added the wallet lifecycle lab for restart-safe mint, swap, send, receive, restore, reconcile, and melt recovery experiments.
- Added funded lifecycle matrix coverage across cashu-ts and CDK against pinned Nutshell and mintd mints.
- Added real Lightning-regtest melt recovery with bounded authenticated settlement probes.
- Hardened CDK lifecycle adapter rehydration after restarts so funded matrix lanes recreate and wait for host adapters before probing.
- Published current lifecycle scope through repository docs and website release docs while keeping certification claims blocked on external evidence.

## 0.1.2 — 2026-07-30

- Added a loopback-only maintainer preview for integrating external wallet adapters.
- Added actionable adapter preflight diagnostics for manifests, authentication, capability
  contracts, profile support, configured read-only evidence endpoints, and connectivity.
- Added capability-aware response-loss and duplicate-delivery checks with automatic fault-gateway
  orchestration and redacted JSON, HTML, and JUnit feedback bundles.
- Hardened retry identity, receiver recovery, proof-state evidence, redemption-start accounting, and
  conflict handling across the reference implementations.
- Improved the website command experience, maintainer contact links, and architecture documentation.

## 0.1.1 — 2026-07-30

- Published the self-contained npm CLI with npm 12-compatible executable metadata.
- Moved automated releases to npm Trusted Publishing with GitHub provenance.
- Kept the real installed-package Docker demo as a publication gate.

## 0.1.0 — 2026-07-28

First experimental v0.1 developer preview.

### Added

- Contract-valid TypeScript, Rust, and Python adapter scaffolds with live-client CI verification.
- Route-aware HTTP and Nostr fault evidence.
- A strict, named 13-scenario release suite and fail-closed release policy.
- Authenticated, disabled-by-default process-crash controls with durable one-shot arms.
- Real funded SIGKILL/restart coverage for four sender and six receiver boundaries.
- PostgreSQL-backed sender reservations, exact payload replay, receiver settlement phases, and safe diagnostics.
- Deterministic redacted JSON, JUnit, and HTML evidence.
- Scenario discovery (`lab ls`), inspection (`lab inspect`), ProtocolId generation (`lab gen-id`), verbose progress, and elapsed-time output.
- OpenAPI 3.1 contract documentation, local environment examples, project governance files, and package-level READMEs.

### Changed

- The adapter template is now a working Fastify scaffold with contract routes, tests, CI, and Docker packaging.
- Direct fault configuration is a portable no-op when no gateway is selected.
- External restart scenarios degrade to explicit `N/A` when a restart controller is unavailable.

### Fixed

- NUT-18 delivery requests now advertise their canonical expiry; restarted senders copy it instead of reconstructing a conflicting expiry.
- Receiver restart routing now targets the selected adapter and records route-specific evidence.
- Docker contexts exclude local worktrees and pnpm stores.
- Settled amounts are checked against merchant credits, and dead transport-convergence logic was removed from the oracle.

### Known limits

- This preview is not a certification.
- The strict release gate remains blocked until independent wallet receivers, distinct qualifying mint identities, trustworthy build provenance, and external integrations exist.
- CDK is a funded sender lane and returns `N/A` for receiver and restart-safe sender claims.
