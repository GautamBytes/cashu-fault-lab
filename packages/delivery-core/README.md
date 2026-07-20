# @cashu-fault-lab/delivery-core

Canonical validation and data-model library for the Cashu Delivery Protocol (`cashu-delivery-v1`).

## Purpose

This package defines all protocol primitives: identifiers, payload encoding, cryptographic fingerprints, receipts, duplicate classification, and fee arithmetic. It is the single source of truth for wire-format correctness. Every other package depends on it.

## Key exports

- **IDs** — `generateProtocolId`, `parseProtocolId` (128-bit random base64url)
- **Payloads** — `parseDeliveryPayload`, `parseDeliveryPayloadJson`, `serializeDeliveryPayload`
- **Receipts** — `assertReceiptTransition`, `mergeObservedReceipt`, `parseDeliveryReceipt`, `serializeDeliveryReceipt`
- **Fingerprints** — `computePayloadHash`, `computeProofSetHash` (SHA-256 over deterministic CBOR)
- **Duplicates** — `classifyDelivery` (4-way conflict classification)
- **Fees** — `computeInputFee`, `computeNetAmount`, `assertExactRequestedAmount`

## Dependencies

- `cborg` — deterministic CBOR encoding for cryptographic hashes (no other runtime deps)

## Tests

```bash
pnpm --filter @cashu-fault-lab/delivery-core test
pnpm --filter @cashu-fault-lab/delivery-core test:consumer
```

## Spec

See `spec/delivery-v1.md` for the normative protocol specification.
