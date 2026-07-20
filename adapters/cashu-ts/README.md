# @cashu-fault-lab/adapter-cashu-ts

HTTP adapter server wrapping `@cashu/cashu-ts` that exposes the lab's 7-route adapter contract.

## Purpose

Enables cashu-ts (TypeScript Cashu library v4.7.2) to participate in fault-injection scenarios as a funded sender. Provides fake-wallet mint funding during reset and persistent (in-memory) delivery state.

## Key exports

- `buildCashuTsAdapterServer` — adapter server with route handlers
- `FundedCashuTsOperations` — pre-funded wallet operations (send, proofs, ledger)
- `buildFundedCashuTsAdapterServer` — convenience factory for a funded adapter

## Current capabilities

| Evidence tier       | Status                            |
| ------------------- | --------------------------------- |
| T0 (codec)          | Supported — parses pinned vectors |
| T1 (transport)      | Supported — funded HTTP sender    |
| T2 (recovery)       | Not implemented                   |
| T3 (durable credit) | Not implemented (sender-only)     |

## Tests

```bash
pnpm --filter @cashu-fault-lab/adapter-cashu-ts test
```

Requires Docker for funded integration tests.
