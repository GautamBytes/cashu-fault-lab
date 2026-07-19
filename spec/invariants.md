# Cashu Fault Lab Invariants

These are release-conformance invariants. A scenario may claim only applicable invariants backed by durable adapter, mint, and runner evidence; an HTTP status alone is insufficient. Current developer-preview coverage and release gaps are listed in the README.

## Safety

1. **At-most-once redemption start per delivery binding.** Duplicate transport messages do not start another mint swap.
2. **At-most-one merchant credit per request.** For single-use requests, all deliveries combined produce zero or one credit.
3. **At-most-one merchant credit per delivery.** Retries, delayed responses, transport failover, and process restarts cannot duplicate ledger effects.
4. **Proof-set exclusivity.** One active proof set cannot be bound to two delivery IDs.
5. **Delivery identity immutability.** A delivery ID never changes request ID, payload hash, proof-set hash, mint, unit, or amount.
6. **Exact net amount.** The credited amount equals the request after NUT-02 input fees, neither under nor over.
7. **No premature settlement.** `settled` requires replacement proofs in the receiver wallet, not only a successful mint response.
8. **No false rejection after possible consumption.** Ambiguous spent/pending inputs without recovered outputs remain `processing/recovery_blocked`.
9. **Monotonic receipts.** Status versions start at one, increment by one for material changes, and never regress after a terminal state.
10. **Stable duplicate response.** An identical duplicate returns the stored receipt and causes no new side effect.

## Liveness

11. **Eventual terminal or explicit recovery state.** Under a healthy mint and eventual message delivery, an accepted payment becomes settled or a pre-consumption validation rejection.
12. **Crash recovery.** A process restart at every persisted state resumes without duplicate credit or loss of recoverable outputs.
13. **Retry convergence.** Bounded sender retries and status polling converge on the receiver's durable receipt.
14. **Transport convergence.** HTTP and Nostr observations of one delivery converge on the same receipt identity and highest status version.

## Evidence

15. **Independent mint evidence.** Proof state is observed through NUT-07 and, where applicable, NUT-09/NUT-19 recovery evidence.
16. **Independent ledger evidence.** Credit count and amount come from the receiver's durable ledger view.
17. **Reproducibility.** Every result records scenario ID, seed, adapter versions, upstream protocol lock, ordered timeline, and invariant evidence.
18. **No unsupported pass.** Missing optional capabilities are `skipped`/`N/A`, never counted as a pass.

The runner's pass condition is the conjunction of every applicable invariant. One violated safety invariant fails the scenario immediately and preserves all available artifacts.
