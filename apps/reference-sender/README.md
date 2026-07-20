# @cashu-fault-lab/reference-sender

Reference implementation of a Cashu sender (Alice) for fault-injection testing.

## Purpose

Encapsulates sender state machines, retry logic, and payment transport over HTTP and Nostr. Provides a Fastify HTTP adapter server that the lab controls at runtime. Uses in-memory state stores (process-local only).

## Key exports

- `sendPayment`, `resumePayment` — send a payment request with retry and idempotency
- `HttpPaymentTransport` — HTTP POST transport for delivery payloads
- `NostrPaymentTransport` — NIP-17 gift-wrap transport
- `InMemorySenderState` — in-memory delivery state with process-local serialization
- `buildSenderAdapterServer` — Fastify server exposing the 7-route adapter contract

## Retry rules

- Create one delivery ID and reserve one proof set before transport
- Reuse exact inner payload bytes on retry
- No HTTP redirects
- Relay acknowledgement is transport evidence only, not settlement
- Verify receiver receipts before releasing proofs

## Tests

```bash
pnpm --filter @cashu-fault-lab/reference-sender test
```

## Note

This is a reference implementation, not a production wallet. Sender state is in-memory and process-local. Production adapters must provide durable reservation, receipt state, and cross-process delivery locking via `SenderState.withDeliveryLock`.
