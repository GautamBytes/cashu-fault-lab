# @cashu-fault-lab/adapter-cashu-ts

HTTP adapter server wrapping `@cashu/cashu-ts` for the experimental v0.1 developer preview.

## Purpose

Enables cashu-ts (TypeScript Cashu library v4.7.2) to participate in fault-injection scenarios as a funded sender and optional delivery-v1 receiver. Provides fake-wallet mint funding during reset, sender delivery state, HTTP and NIP-17 Nostr delivery, and optional PostgreSQL-backed receiver settlement evidence.

## Key exports

- `buildCashuTsAdapterServer` — adapter server with route handlers
- `FundedCashuTsOperations` — pre-funded wallet operations (send, proofs, ledger)
- `FundedCashuTsReceiverOperations` — delivery-v1 receiver operations (request, pay, ledger, proofs)
- `FundedCashuTsDualRoleOperations` — composed sender + receiver adapter operations
- `buildFundedCashuTsAdapterServer` — convenience factory for a funded adapter
- `CashuTsNostrTransport` / `CashuTsNostrReceiver` — NIP-17 sender and receiver relay glue
- `ResettablePostgresReceiverStore` — PostgreSQL-backed receiver evidence wrapper
- `PostgresCashuTsSenderStore` — PostgreSQL-backed funded sender delivery state

## Current capabilities

| Capability                 | Status                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| T0 (codec)                 | Supported — parses pinned vectors                                 |
| T1 (transport)             | Supported — funded HTTP and NIP-17 Nostr sender/receiver paths    |
| T2 (recovery)              | Supported — four sender and six receiver process-crash boundaries |
| T3 (durable credit)        | Supported when `CFL_CASHU_TS_RECEIVER_DATABASE_URL` is configured |
| Persistent sender delivery | Supported when `CFL_CASHU_TS_SENDER_DATABASE_URL` is configured   |

Receiver mode is enabled when `CFL_CASHU_TS_CLAIM_KEY` is configured with at least one payment transport:

- HTTP: `CFL_CASHU_TS_PAYMENT_TARGET`
- Nostr: `CFL_CASHU_TS_NOSTR_RECEIVER_KEY` plus `CFL_CASHU_TS_NOSTR_RELAYS`

Sender Nostr support is enabled with `CFL_CASHU_TS_NOSTR_SENDER_KEY`. Durable sender delivery state is enabled with `CFL_CASHU_TS_SENDER_DATABASE_URL`, `CFL_CASHU_TS_SENDER_RUN_ID`, `CFL_CASHU_TS_SENDER_ACTIVE_KEY_VERSION`, and `CFL_CASHU_TS_SENDER_STATE_KEYS` in `version:base64url-32-byte-key` form. Durable receiver evidence is enabled with `CFL_CASHU_TS_RECEIVER_DATABASE_URL` and a 32-byte base64url `CFL_CASHU_TS_RECEIVER_STATE_KEY`; migrations are applied at startup.

Process-crash controls exist only when `CFL_CASHU_TS_TEST_CRASH_CONTROL=1` and durable PostgreSQL sender state is configured. They reuse the adapter bearer token, persist one-shot arms, and are disabled by default. They are a lab mechanism, not a production API.

## Tests

```bash
pnpm --filter @cashu-fault-lab/adapter-cashu-ts test
```

Real relay and PostgreSQL E2E checks are opt-in because they bind local ports and/or start Docker:

```bash
CFL_NOSTR_RELAY_E2E=1 pnpm --filter @cashu-fault-lab/adapter-cashu-ts test -- test/nostr-relay-e2e.test.ts
CFL_POSTGRES_E2E=1 pnpm --filter @cashu-fault-lab/adapter-cashu-ts test -- test/postgres-receiver-store.test.ts
CFL_POSTGRES_E2E=1 pnpm --filter @cashu-fault-lab/adapter-cashu-ts test -- test/postgres-sender-store.test.ts
CFL_FUNDED_CRASH_E2E=1 pnpm --filter @cashu-fault-lab/scenario-runner test -- test/funded-crash-boundaries.test.ts
```
