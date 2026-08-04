# v0.1.4 audit hardening implementation plan

## Goal

Close the actionable code and contract gaps found in the v0.1.4 grant-readiness audit while
preserving the wallet doctor's read-only safety boundary.

## Design

Capture schema v2 is a redacted, content-addressed evidence envelope. It stores normalized NIP-60
views and per-relay event identifiers, but never stores signed event bodies, NIP-44 ciphertext,
proof secrets, signatures, or wallet private-key material. Offline consumers validate the JSON
schema, canonical digest, subject/relay consistency, and exact proof-to-NUT-07 coverage. The CLI
`check` command is the strong external gate: it requires the subject key, recaptures the named
relays and mint state, and compares that independently produced capture with the supplied one.

Mint calls use an HTTPS-by-default policy (HTTP is allowed only for loopback lab fixtures), reject
redirects, bound response bytes and proof counts, batch requests, and enforce NUT-07's exact
one-for-one response ordering. Relay responses are explicitly bound to the requested author and
relevant kinds. Relay discovery reads the latest valid kind 10019 relay tags and falls back to the
latest kind 10002 NIP-65 write/bidirectional relay tags from operator-supplied bootstrap relays.

## Tasks

### 1. Capture privacy and integrity

- Add failing contract tests proving captures contain no raw event content and that altered,
  incomplete, or cross-subject captures fail integrity validation.
- Replace `rawRelays` with redacted `relayEvidence` in a schema v2 bundle and update the canonical
  digest domain.
- Add semantic integrity validation for digest, subject, relay evidence, seen-on URLs, duplicate
  proof truth, and exact mint-state coverage.
- Update the committed JSON schema and contract drift test.

### 2. Independent check

- Add failing runner/CLI tests for forged digests, missing mint truth, and live-capture mismatch.
- Make the pure check fail closed on integrity errors and expose stable integrity failures in its
  machine-readable summary.
- Add live recapture comparison and make the CLI gate require the subject key before passing.
- Define and validate committed diagnosis, repair-plan, and check artifact schemas.

### 3. NUT-07 and untrusted input hardening

- Add failing tests for missing, extra, duplicate, reordered, and wrong-Y responses; unsafe mint
  URLs; redirects; oversized bodies; and oversized proof sets.
- Implement strict mint URL policy, bounded parsing, batching, and exact response correspondence.
- Bound decrypted token fields and aggregate proof collection.

### 4. Nostr semantics and discovery

- Add failing tests showing wrong-author events are ignored and kind-5 events without
  `["k","7375"]` do not delete token events.
- Bind fetched events to author/kind and enforce the NIP-60 deletion-kind rule.
- Add tests and implementation for kind 10019 relay discovery with latest-event semantics and
  kind 10002 NIP-65 fallback.
- Expose discovery through `collect --discover-from` while retaining explicit `--relay` support.

### 5. Oracle and scenario coverage

- Add a failing oracle test for an entirely missing kind 17375 wallet event and emit
  `WALLET_EVENT_FORK`.
- Add two packaged scenarios so the matrix contains nine stable cases, covering wallet absence
  and irrelevant deletion behavior in the in-process lane.

### 6. Supply chain, generated docs, and release truth

- Raise vulnerable `fast-uri` and `postcss` overrides and regenerate the lockfile.
- Reconcile the profile/ADR/docs with the actual funded wallet-doctor release workflow.
- Regenerate CLI reference and run formatting/codegen drift checks.

### 7. Verification

- Run focused red/green tests after every production change.
- Run unit tests, typecheck, build, format check, codegen check, CLI-doc check, production audit,
  CLI wallet-doctor E2E, and all available non-funded verification lanes.
- Record the final graph trace and preserve the completed feature branch for review.
