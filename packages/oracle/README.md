# @cashu-fault-lab/oracle

Formal safety model for payment delivery verification.

## Purpose

Accumulates observations from the scenario runner and checks 18+ invariants across retries, duplicates, crashes, and transport convergence. The oracle never imports code from the system under test — it only judges evidence.

## Key exports

- **Model** — `OracleModel`, `emptyOracleModel` (requests, deliveries, proofs, credits, receipts)
- **Observations** — `Observation` (request_observed, delivery_attempted, receipt_observed, etc.)
- **Invariants** — `assertSafety` (safety invariants), `assertQuiescentLiveness` (liveness check)
- **Transitions** — `applyObservation` (immutable model update)

## Invariants checked

- Delivery identity immutability
- Proof-set exclusive ownership (no double-spend)
- At-most-once redemption and settlement plan
- Single-use request credit enforcement
- Monotonic, non-regressing receipts
- No rejection after possible consumption
- Net amount consistency
- Quiescence (every delivery reaches terminal state)

## Tests

```bash
pnpm --filter @cashu-fault-lab/oracle test
pnpm --filter @cashu-fault-lab/oracle test:consumer
```

Property tests use `fast-check` to generate random delivery histories and verify no invariant violations.
