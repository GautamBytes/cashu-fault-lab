# `nip60-doctor-v1` — NIP-60 wallet diagnosis profile

Status: experimental developer preview. This profile defines how the wallet doctor reconstructs
and judges NIP-60 wallet state. It produces diagnostic evidence, not wallet certification. Its
funded matrix is a separate tagged-release prerequisite; it does not change the delivery or
lifecycle gate contracts.

Protocol baseline: Nostr NIPs `bdfa7e62ef87fcfcb992b1a27aee49d36b0b4f91` (NIP-60, NIP-09, NIP-44,
NIP-40) and Cashu NUTs `fccb68e9129de5348003f573dc97e1ee380a1076` (NUT-00, NUT-07, NUT-09).

## 1. Inputs

A diagnosis consumes one versioned capture bundle (`spec/schemas/nip60-capture.schema.json`):

- **Per-relay observations**: for every relay, the `kind:17375` wallet event versions it serves,
  the `kind:7375` token events, the NIP-09 `kind:5` deletions, optional `kind:7376` history and
  `kind:7374` quote events, and malformed entries (decryption failure, invalid payload, wallet
  without mints). Relay failures are recorded, never hidden; the `check` CI gate fails when any
  relay in the capture has `status: error` (incomplete evidence is not a pass).
- **Mint truth**: every proof discovered in any token event is classified `UNSPENT`, `SPENT`, or
  `PENDING` by its mint via NUT-07 `checkstate`. Proof secrets are dropped at capture; artifacts
  store only the public NUT-00 `Y`.

Capture v2 also stores secret-free per-relay event identifiers. It never exports event bodies,
NIP-44 ciphertext, signatures, proof secrets, or wallet private-key material. Structural consumers
verify the canonical digest and exact proof/mint coverage. The external `check` gate additionally
re-fetches relays and mints with the subject key and rejects any evidence mismatch.
Capture v2 is a breaking v0.2.0 contract. Released v1 captures must be recollected; transforming
them cannot prove the v2 redaction and completeness invariants.

## 2. The three reconstructions

1. **Per-relay view** — what an application reading only relay R computes: live tokens are the
   token events R serves minus the ones R also serves a deletion for; the wallet event is the
   latest `17375` R serves.
2. **Merged view** — union over relays with global semantics: a token event is globally live when
   no relay serves a deletion for it **and** no seen event lists it in `del`. A naive reader that
   instead unions per-relay live events may count one proof twice; the difference is reported as
   `doubleCounted` with the duplicated proofs listed.
3. **Mint-verified truth** — the sum of `UNSPENT` proofs referenced by live events plus orphaned
   `UNSPENT` proofs (see below).

## 3. Diagnosis codes

| Code                      | Severity                                 | Condition                                                            | User symptom                         |
| ------------------------- | ---------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| `RELAY_PARTITION`         | warning                                  | A globally live event is served by a strict subset of healthy relays | Balance differs between apps         |
| `GHOST_TOKEN`             | error                                    | A live event carries proofs the mint reports `SPENT`                 | App shows sats that are gone         |
| `ORPHANED_PROOFS`         | error                                    | Proofs are `UNSPENT` at the mint but referenced by no live event     | Sats missing; recoverable via NUT-09 |
| `DEL_CHAIN_BREAK`         | error                                    | An event superseded by a seen `del` chain stays live on some relay   | Double-shown or flapping balance     |
| `WALLET_EVENT_FORK`       | error                                    | Relays serve conflicting or no `17375` versions                      | Wallet not recognized                |
| `DELETION_NOT_PROPAGATED` | warning                                  | A `kind:5` exists on one relay while its target stays live elsewhere | Flapping balance                     |
| `HISTORY_GAP`             | info                                     | History entries reference unknown token events                       | Incomplete transaction history       |
| `QUOTE_LIMBO`             | info                                     | Unexpired `kind:7374` quote events sit on relays                     | Pending mint that never completes    |
| `MALFORMED_EVENT`         | error (wallet/token kinds), else warning | Undecryptable or schema-invalid content                              | App silently ignores state           |

`GHOST_TOKEN` is evaluated only over globally live events; a superseded predecessor carrying spent
proofs is owned by `DEL_CHAIN_BREAK`. `DELETION_NOT_PROPAGATED` yields to `DEL_CHAIN_BREAK` when a
successor's `del` references the target.

## 4. Repair plans (dry-run)

A plan is a deterministic, content-addressed artifact. Mint-consolidation findings (`GHOST_TOKEN`,
`DEL_CHAIN_BREAK`) produce one planned rollover per affected mint covering exactly the non-SPENT
proofs of that mint's live events, plus NIP-09 deletions of everything it replaces. Healthy
partitioned events get minimal republish steps. Orphaned `UNSPENT` proofs become `wallet_action`
NUT-09 restore instructions, because only a wallet holding the secrets can recover them.

Safety invariants verified by the independent oracle:

- **P1**: no deletion drops a non-SPENT proof that no rollover covers and no wallet action restores.
- **P2**: applying the plan twice yields the state of applying it once.
- **P3**: every event id and proof the plan references exists in the capture.
- **Convergence**: after simulation, no `SPENT` proof stays live, no proof is duplicated across
  live events, and the unique-proof balance equals the non-SPENT value the live events carried.

Nothing is published by the doctor. Execution requires an explicit future ADR.

## 5. Evidence and redaction

Capture bundles, diagnosis artifacts, plan artifacts, check artifacts, and scenario results are
versioned JSON written mode `0600`. Their normative schemas live in
`spec/schemas/nip60-*.schema.json`; committed Rust and Python files expose digest/version metadata,
not complete models. Proof secrets, ciphertext, signatures, and the
NIP-60 wallet `privkey` never appear in exported artifacts.
Scenario artifacts carry a domain-separated seed hash; replay requires the original seed out of
band and compares diagnosis codes and balances, not fresh event ids.
