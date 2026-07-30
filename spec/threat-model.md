# Cashu Fault Lab Threat Model

## Goal

The lab tests payment-delivery interoperability and fault tolerance. It aims to detect duplicate redemption, duplicate merchant credit, false settlement, unrecoverable ambiguous mint outcomes, and incompatible wire behavior.

## Assets

- Sender proofs and change.
- Receiver replacement proofs.
- Merchant credit ledger integrity.
- Request and delivery identity bindings.
- Receipt history and recovery state.
- Deterministic restore secrets and blinding derivation state.
- Scenario evidence used to claim interoperability.

## Trust boundaries

1. Sender wallet to delivery transport.
2. HTTP or Nostr transport to receiver adapter.
3. Receiver process to durable database.
4. Receiver wallet to mint endpoints.
5. Runner to implementation adapters.
6. Runner report to human or CI consumer.
7. Adapter capability and build identity claims to the release-policy evaluator.

The mint is authoritative for proof state and signatures, but its network can fail at any byte boundary. An adapter is not trusted to self-report a passing result without independent evidence.

## Fault and attacker capabilities

The release target covers duplicate, drop, delay, reorder, truncate, and replay of delivery messages and responses. It also covers connection loss around receiver persistence, mint request transmission, mint response receipt, output storage, and ledger credit, plus sender, receiver, gateway, and adapter process restarts at named crash points.

Current developer-preview coverage includes packaged request/response loss, duplication,
cross-transport retries, and an in-memory mint-response-loss recovery flow. Funded cashu-ts lanes
exercise four sender and six receiver SIGKILL/restart boundaries, and the repository runs NIP-17
delivery through its real WebSocket relay. PostgreSQL integration tests cover durable prepared-state
recovery, ambiguous mint response recovery, atomic credit, and concurrent-worker leasing.
Delay/reorder remain gateway and relay component tests rather than packaged end-to-end lanes. These
results are internal evidence, not independent release qualification: public-relay hardening,
external wallet implementations, independent evidence authorities, and distinct qualifying mints
remain release-gated.

Inputs may include:

- reused delivery IDs with changed payloads;
- reused proof sets under new delivery IDs;
- concurrent deliveries for one single-use request;
- malformed JSON, invalid UTF-8, oversized payloads, sparse in-memory arrays, unsafe integers, and extension fields;
- expired or future-dated messages;
- wrong request ID, mint, unit, amount, or transport version;
- stale, duplicated, conflicting, or out-of-order receipts;
- forged Nostr rumor/seal/wrapper relationships and replayed gift wraps.

## Required controls

- Cryptographically random 128-bit request and delivery IDs in production; deterministic injection only in tests.
- Canonical fingerprints with domain separation.
- Database uniqueness for delivery, proof, request-reservation, and ledger-credit identities.
- One transaction for classification and reservation; one transaction for settlement and credit.
- Deterministic mint outputs persisted before swap.
- No secret, proof, token, private key, or blinding factor in normal logs or reports.
- Payload size, proof count, retry count, concurrency, and timeout bounds.
- HTTPS except explicit loopback test mints.
- NIP-17/NIP-59 author/seal validation and replay deduplication.
- Reports distinguish observed evidence, adapter claims, skipped capabilities, and runner inference.
- Release decisions require distinct implementation, language, source/build, and mint provenance.
- Adapter-claimed invariant evidence never qualifies, even when the scenario otherwise passes.
- Docker or funded-service absence never becomes a release pass.

## Out of scope

- Breaking Cashu blind signatures, secp256k1, SHA-256, CBOR, NIP-44, or the mint's cryptography.
- Proving mint solvency or preventing a malicious mint from refusing service.
- Final merchant business fulfillment outside the tested credit ledger.
- Global exactly-once delivery. The system provides at-least-once transport plus idempotent, durable effects.
- Standardizing this experimental profile. Acceptance by Cashu maintainers requires separate review and consensus.

## Residual risks

- A mint that consumes inputs but supports neither usable NUT-19 caching nor recoverable NUT-09 state may leave a payment recovery-blocked indefinitely.
- Without active NUT-19 replay, a crash after durable `mint_sent` but before network dispatch is indistinguishable from an in-flight request. The receiver chooses safety and stays recovery-blocked even if a NUT-07 snapshot reports every input unspent.
- Incorrect wallet proof-`Y` derivation can weaken cross-delivery duplicate evidence; real-mint checks remain authoritative.
- Clock skew beyond the bounded allowance can reject otherwise valid attempts.
- Database loss or rollback can defeat local idempotency unless deployment-level durability and backups are sound.
- Current NUT-26 and NUT-18/NIP-17 descriptions can produce incompatible Nostr messages; the lab surfaces rather than hides this mismatch.
- Deterministic development digests identify local fixtures but are not substitutes for signed or independently reproduced release-build provenance.
