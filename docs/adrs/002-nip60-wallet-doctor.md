# ADR 002: NIP-60 wallet doctor scope and safety boundary

- Status: Accepted for lab use
- Date: 2026-08-03
- Protocol baseline: Nostr NIPs `bdfa7e62ef87fcfcb992b1a27aee49d36b0b4f91` (contains current NIP-60 text, verified byte-identical to master on 2026-08-03)
- Cashu baseline: NUTs `fccb68e9129de5348003f573dc97e1ee380a1076`

## Context

NIP-60 stores Cashu wallet state on Nostr relays: a replaceable `kind:17375` wallet event,
`kind:7375` token events rolled over through `del` references, NIP-09 `kind:5` deletions, and
optional `kind:7376` history and `kind:7374` quote events. Relays hold partial, divergent copies
of this state, so two applications reading different relay sets can disagree about a balance or
fail to recognize the same wallet. Users experience this as missing or duplicated sats.

The 2026-08-01 lifecycle design excluded "NIP-60 relay diagnosis, repair, or wallet-event
reconciliation" from the lifecycle suite. That exclusion scoped one suite, not the repository.

## Decision

The lab gains a separate `nip60-doctor-v1` suite that:

1. Collects a subject's NIP-60 events from multiple relays (read-only).
2. Reconstructs the wallet three ways — per-relay view, merged multi-relay view, and
   mint-verified truth via NUT-07 `checkstate` — and diffs them into stable diagnosis codes.
3. Emits a deterministic, dry-run repair plan artifact. The doctor never publishes events and
   never moves value. Plan execution is out of scope for v1.

The suite reuses only genuinely common infrastructure (capture/replay/report patterns, fault
relay, Docker fixtures, CI tiers). It does not change the `cashu-delivery-v1` or
`wallet-lifecycle-v1` contracts, and its output is diagnostic evidence, not certification. The
doctor is a separate funded release workflow prerequisite: its failure blocks a tagged lab
release, but passing it does not certify a wallet and does not alter the delivery/lifecycle
contracts or their pass criteria.

## Safety boundary

- Proof secrets are dropped at capture time. Artifacts store only each proof's NUT-00 `Y`
  (hash-to-curve of the secret), which is the public value a wallet already sends to a mint in
  NUT-07 state checks.
- The NIP-60 wallet `privkey` value (P2PK key inside `kind:17375`) is discarded during
  normalization and is never stored or exported; capture records only whether the field exists.
- Exported capture v2 bundles discard all signed event bodies, NIP-44 ciphertext, and signatures.
  Relay evidence contains only event identifiers. `check` independently re-fetches the relay and
  mint evidence with the subject key before it can pass.
- Subject keys are supplied through environment variables on the operator's own machine, never
  through command arguments, and existing `Bearer`/`nsec1` redaction applies to all output.
- Outbound relay and mint connections require public WSS/HTTPS destinations and use the validated
  DNS answer for the actual socket connection. Private, link-local, reserved, and mixed DNS
  answers are rejected. Loopback WS/HTTP is available only through the explicit local-lab flag.
- Capture work is bounded by relay, event, proof-candidate, distinct-mint, ciphertext-byte,
  response-byte, and overall-time limits before expensive normalization or network fan-out.
- Orphaned unspent proofs require a NUT-09 restore by a wallet holding the secrets; the doctor
  emits a `wallet_action` instruction instead of attempting it.

## Consequences

- New packages `wallet-doctor-{core,contract,oracle,runner}` follow the lifecycle dependency
  rules: the oracle imports no wallet, relay, or mint implementation code.
- A new ADR must precede any repair-execution feature or any treatment of doctor output as wallet
  certification.
