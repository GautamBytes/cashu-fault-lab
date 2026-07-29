# Changelog

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
