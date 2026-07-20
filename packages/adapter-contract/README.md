# @cashu-fault-lab/adapter-contract

TypeScript types, JSON Schema validation, and an HTTP client for the Cashu Fault Lab adapter contract.

## Purpose

Defines the language-neutral 7-route HTTP contract that every wallet adapter must serve. Adapters in any language can implement these routes and be discovered dynamically by the lab. The JSON Schemas in `spec/schemas/` are normative; the TypeScript types are a convenience.

## Key exports

- **Types** — `AdapterClient`, `AdapterCapabilities`, `EvidenceTier`, `AdapterRole`
- **Client** — `HttpAdapterClient` (fetch-based HTTP client with schema validation)
- **Validation** — `validateAdapterRequest`, `validateAdapterResponse` (AJV-based)
- **Schemas** — Loaded from `spec/schemas/` at import time

## Routes defined

| Method | Route                | Purpose                         |
| ------ | -------------------- | ------------------------------- |
| `GET`  | `/v1/capabilities`   | Declare implementation identity |
| `POST` | `/v1/reset`          | Reset deterministic test state  |
| `POST` | `/v1/requests`       | Create a payment request        |
| `POST` | `/v1/send`           | Send a payment                  |
| `GET`  | `/v1/deliveries/:id` | Read delivery receipt           |
| `GET`  | `/v1/ledger`         | Merchant credit evidence        |
| `GET`  | `/v1/proofs`         | Proof-state evidence            |

## Tests

```bash
pnpm --filter @cashu-fault-lab/adapter-contract test
pnpm --filter @cashu-fault-lab/adapter-contract test:consumer
```

## Reference

- `spec/openapi.yaml` — OpenAPI 3.1 specification
- `docs/adapter-guide.md` — Full integration guide
