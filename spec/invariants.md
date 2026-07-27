# Cashu Fault Lab Invariants

These are release-conformance invariants. A scenario may claim only applicable invariants backed by durable adapter, mint, and runner evidence; an HTTP status alone is insufficient. Current developer-preview coverage and release gaps are listed in the README.

## Safety

1. **At-most-once redemption start per delivery binding** (`at-most-once-redemption-start`). Duplicate transport messages do not start another mint swap.
2. **At-most-one merchant credit per request** (`at-most-one-merchant-credit-per-request`). For single-use requests, all deliveries combined produce zero or one credit.
3. **At-most-one merchant credit per delivery** (`at-most-one-merchant-credit-per-delivery`). Retries, delayed responses, transport failover, and process restarts cannot duplicate ledger effects.
4. **Proof-set exclusivity** (`proof-set-exclusivity`). One active proof set cannot be bound to two delivery IDs.
5. **Delivery identity immutability** (`delivery-identity-immutability`). A delivery ID never changes request ID, payload hash, proof-set hash, mint, unit, or amount.
6. **Exact net amount** (`exact-net-amount`). The credited amount equals the request after NUT-02 input fees, neither under nor over.
7. **No premature settlement** (`no-premature-settlement`). `settled` requires replacement proofs in the receiver wallet, not only a successful mint response.
8. **No false rejection after possible consumption** (`no-false-rejection-after-possible-consumption`). Ambiguous spent/pending inputs without recovered outputs remain `processing/recovery_blocked`.
9. **Monotonic receipts** (`monotonic-receipts`). Status versions start at one, increment by one for material changes, and never regress after a terminal state.
10. **Stable duplicate response** (`stable-duplicate-response`). An identical duplicate returns the stored receipt and causes no new side effect.

## Liveness

11. **Eventual terminal or explicit recovery state** (`eventual-terminal-or-recovery-state`). Under a healthy mint and eventual message delivery, an accepted payment becomes settled or a pre-consumption validation rejection.
12. **Crash recovery** (`crash-recovery`). A process restart at every persisted state resumes without duplicate credit or loss of recoverable outputs.
13. **Retry convergence** (`retry-convergence`). Bounded sender retries and status polling converge on the receiver's durable receipt.
14. **Transport convergence** (`transport-convergence`). HTTP and Nostr observations of one delivery converge on the same receipt identity and highest status version.

## Evidence

15. **Independent mint evidence** (`independent-mint-evidence`). Proof state is observed through NUT-07 and, where applicable, NUT-09/NUT-19 recovery evidence.
16. **Independent ledger evidence** (`independent-ledger-evidence`). Credit count and amount come from the receiver's durable ledger view.
17. **Reproducibility** (`reproducibility`). Every result records scenario ID, seed, adapter versions, upstream protocol lock, ordered timeline, and invariant evidence.
18. **No unsupported pass** (`no-unsupported-pass`). Missing optional capabilities are `skipped`/`N/A`, never counted as a pass.

The runner's pass condition is the conjunction of every applicable invariant. One violated safety invariant fails the scenario immediately and preserves all available artifacts.

Scenario artifacts contain one result for every identifier above. `passed` requires observed or reproducibly derived evidence; `failed` records a violation; `not_applicable` means the scenario did not exercise the behavior; and `not_observable` means the behavior applied but the required evidence was unavailable. Confidence is recorded separately as `observed`, `derived`, or `adapter_claimed`. Adapter-claimed evidence never qualifies a release.
