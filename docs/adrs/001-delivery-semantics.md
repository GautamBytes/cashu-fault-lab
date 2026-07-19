# ADR 001: Payment delivery semantics

- Status: Accepted for lab use
- Date: 2026-07-19
- Protocol baseline: Cashu NUTs `fccb68e9129de5348003f573dc97e1ee380a1076`
- Nostr baseline: NIPs `bdfa7e62ef87fcfcb992b1a27aee49d36b0b4f91`

## Context

NUT-18 defines payment requests and HTTP or NIP-17 delivery. Cashu proofs remain bearer assets, so a sender cannot infer settlement from a lost HTTP response or a relay `OK`. Retrying helps delivery but can expose receiver races, repeated mint swaps, or repeated merchant credits.

NUT-03, NUT-07, NUT-09, and NUT-19 give a receiver enough mint operations to settle or recover. They do not define merchant ledger idempotency, retry identifiers, or delivery receipts. Wallets need a testable application profile for those rules.

## Decision

The lab uses at-least-once transport and idempotent receiver processing. It makes no exactly-once transport claim.

One logical payment keeps the same request ID, delivery ID, proof set, inner payload bytes, payload hash, and prepared swap outputs across retries. A NIP-17 retry creates a fresh NIP-59 wrapper around those inner bytes.

The receiver claims these values in one transaction before calling a mint:

- delivery ID and immutable payload hash;
- proof ownership and single-use request reservation;
- encrypted swap plan with exact outputs;
- settlement and merchant credit uniqueness.

The receiver credits a merchant after its own NUT-03 result or recovery of the same outputs through NUT-19 replay or NUT-09 restore. NUT-07 `SPENT` evidence cannot create credit by itself.

The lab publishes `cashu-delivery-v1` schemas and receipts as an experimental application profile. The harness works with existing NUTs. Interoperability evidence from independent wallets can support a later standard proposal.

## NUT-26 compatibility

The pinned NUT-18 Nostr transport uses an `nprofile` target and an `n=17` tag. The pinned NUT-26 mapping uses NIP-04 with a raw 32-byte X-only public key. The matrix reports `NUT26_NIP_MAPPING_MISMATCH` as an expected failure. Adapters must not translate one mapping into the other and report a pass.

## Consequences

Receivers need durable state, unique constraints, encrypted recovery material, and a recovery worker. Senders need durable proof reservations and receipt state. Operators can replay a redacted failure artifact without storing proof secrets.

Adapters can start at codec evidence tier T0. T1 through T3 require transport, fault, and real-mint evidence. Unsupported tiers return `N/A` with a reason.

The team should propose a Cashu standard only after two independent sender and receiver implementations agree on wire bytes, conflict behavior, receipt transitions, and recovery results.
