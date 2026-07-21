# @cashu-fault-lab/adapter-cashu-ts

HTTP adapter server wrapping `@cashu/cashu-ts` that exposes the lab's 7-route adapter contract.

## Purpose

Enables cashu-ts (TypeScript Cashu library v4.7.2) to participate in fault-injection scenarios as a funded sender and optional delivery-v1 receiver. Provides fake-wallet mint funding during reset, in-memory sender delivery state, and in-memory receiver settlement evidence.

## Key exports

- `buildCashuTsAdapterServer` — adapter server with route handlers
- `FundedCashuTsOperations` — pre-funded wallet operations (send, proofs, ledger)
- `FundedCashuTsReceiverOperations` — delivery-v1 receiver operations (request, pay, ledger, proofs)
- `FundedCashuTsDualRoleOperations` — composed sender + receiver adapter operations
- `buildFundedCashuTsAdapterServer` — convenience factory for a funded adapter

## Current capabilities

| Evidence tier       | Status                                      |
| ------------------- | ------------------------------------------- |
| T0 (codec)          | Supported — parses pinned vectors           |
| T1 (transport)      | Supported — funded HTTP sender and receiver |
| T2 (recovery)       | Not implemented                             |
| T3 (durable credit) | Not implemented (in-memory receiver store)  |

Receiver mode is enabled when both `CFL_CASHU_TS_CLAIM_KEY` and `CFL_CASHU_TS_PAYMENT_TARGET` are configured. The Docker compose example sets both and exposes `cashu-ts` as a dual-role delivery-v1 participant.

## Tests

```bash
pnpm --filter @cashu-fault-lab/adapter-cashu-ts test
```

Requires Docker for funded integration tests.
