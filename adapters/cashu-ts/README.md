# @cashu-fault-lab/adapter-cashu-ts

HTTP adapter server wrapping `@cashu/cashu-ts` that exposes the lab's 7-route adapter contract.

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

## Current capabilities

| Evidence tier       | Status                                                            |
| ------------------- | ----------------------------------------------------------------- |
| T0 (codec)          | Supported — parses pinned vectors                                 |
| T1 (transport)      | Supported — funded HTTP and NIP-17 Nostr sender/receiver paths    |
| T2 (recovery)       | Not claimed yet — replacement-proof recovery suite remains gated  |
| T3 (durable credit) | Supported when `CFL_CASHU_TS_RECEIVER_DATABASE_URL` is configured |

Receiver mode is enabled when `CFL_CASHU_TS_CLAIM_KEY` is configured with at least one payment transport:

- HTTP: `CFL_CASHU_TS_PAYMENT_TARGET`
- Nostr: `CFL_CASHU_TS_NOSTR_RECEIVER_KEY` plus `CFL_CASHU_TS_NOSTR_RELAYS`

Sender Nostr support is enabled with `CFL_CASHU_TS_NOSTR_SENDER_KEY`. Durable receiver evidence is enabled with `CFL_CASHU_TS_RECEIVER_DATABASE_URL` and a 32-byte base64url `CFL_CASHU_TS_RECEIVER_STATE_KEY`; migrations are applied at startup.

## Tests

```bash
pnpm --filter @cashu-fault-lab/adapter-cashu-ts test
```

Real relay and PostgreSQL E2E checks are opt-in because they bind local ports and/or start Docker:

```bash
CFL_NOSTR_RELAY_E2E=1 pnpm --filter @cashu-fault-lab/adapter-cashu-ts test -- test/nostr-relay-e2e.test.ts
CFL_POSTGRES_E2E=1 pnpm --filter @cashu-fault-lab/adapter-cashu-ts test -- test/postgres-receiver-store.test.ts
```
