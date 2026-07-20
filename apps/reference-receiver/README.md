# @cashu-fault-lab/reference-receiver

Reference implementation of a Cashu receiver (Bob) with PostgreSQL-backed transactional settlement and crash recovery.

## Purpose

Handles delivery acceptance, proof verification, encrypted swap plan creation, mint interaction, atomic merchant credit, and concurrent recovery worker leasing. Provides a Fastify HTTP adapter server.

## Key exports

- `acceptDelivery` — parse, verify, prepare, and settle a delivery
- `recoverDelivery` — resume an in-flight delivery after a crash
- `PostgresReceiverStore` — PostgreSQL-backed state with SERIALIZABLE transactions
- `MemoryReceiverStore` — in-memory store for testing
- `RecoveryWorker` — background worker that leases stale deliveries and recovers them
- `CashuTsMintGateway` — mint interaction via `@cashu/cashu-ts`
- `buildReceiverHttpServer`, `buildFundedReceiverAdapterServer` — Fastify servers

## Recovery state machine

```
prepared → mint_sent → settled
                  ↘ recovery_blocked (ambiguous swap, manual intervention)
                  ↘ rejected (deterministic error)
```

Crash boundaries covered:

- After prepare, before mint dispatch (phase=prepared, worker recovers)
- After swap sent, response lost (phase=mint_sent, NUT-09/NUT-19 restore)
- Concurrent worker leasing (FOR UPDATE SKIP LOCKED)

## Tests

```bash
pnpm --filter @cashu-fault-lab/reference-receiver test
```

Requires Docker for PostgreSQL integration tests.
