# Cashu Fault Lab adapter template

Copy this directory as a starting point for a new wallet adapter. Replace each `TODO` in
`src/server.ts` with your wallet's real implementation.

## Quick start

```bash
# Copy the template
cp -r adapters/template adapters/my-wallet

# Fill in the route stubs
# 1. Edit package.json — change name and bin
# 2. Edit src/server.ts — replace implementation/version in capabilities
# 3. Implement the route handlers one at a time

# Install and verify
pnpm install
pnpm --filter @cashu-fault-lab/adapter-template test
pnpm --filter @cashu-fault-lab/adapter-template typecheck
pnpm --filter @cashu-fault-lab/adapter-template build
```

## Route reference

| Method | Route                | Purpose                                   | T0           | T1        | T2        | T3        |
| ------ | -------------------- | ----------------------------------------- | ------------ | --------- | --------- | --------- |
| `GET`  | `/v1/capabilities`   | Declare implementation and profiles       | Required     | Required  | Required  | Required  |
| `POST` | `/v1/reset`          | Reset test state from a seed              | Required     | Required  | Required  | Required  |
| `POST` | `/v1/requests`       | Create a payment request (receiver)       | Required     | Required  | Required  | Required  |
| `GET`  | `/v1/deliveries/:id` | Read the current receipt (receiver)       | Required     | Required  | Required  | Required  |
| `POST` | `/v1/send`           | Send or resume a logical payment (sender) | Parsing only | Real send | Real send | Real send |
| `GET`  | `/v1/ledger`         | Return merchant credit evidence           | N/A          | N/A       | N/A       | Required  |
| `GET`  | `/v1/proofs`         | Return proof-state evidence               | N/A          | N/A       | Required  | Required  |

## Evidence tier progression

1. **T0 (codec conformance)**: Parse `spec/vectors/` and pass the conformance scenarios.
2. **T1 (transport)**: Fund a wallet, send real proofs through your transport, reconcile a receiver receipt.
3. **T2 (recovery)**: Prove recovery of replacement proofs via NUT-09/NUT-19 after a crash.
4. **T3 (durable credit)**: Prove one durable merchant-ledger credit, externally verifiable.

## Key rules

- Bind to loopback (`127.0.0.1`) by default.
- Require a Bearer token from an environment variable; never put it in manifests or logs.
- For retries: reuse the same delivery ID and exact inner payload bytes.
- Return `501 { "status": "N/A", "reason": "..." }` for unimplemented routes.
- Never expose proof secrets, blinding factors, or private keys in adapter responses.

## Running with the lab

Add your adapter to a manifest file:

```json
{
  "schemaVersion": 1,
  "adapters": [
    { "id": "my-wallet", "url": "http://127.0.0.1:4103", "tokenEnv": "CFL_TEMPLATE_TOKEN" }
  ]
}
```

Then:

```bash
export CFL_TEMPLATE_TOKEN=lab-only-token
pnpm --filter @cashu-fault-lab/adapter-template start &

pnpm lab matrix --profile delivery-v1 --adapters manifest.json
pnpm lab run scenarios/retry/response-lost.json \
  --adapters manifest.json \
  --sender my-wallet \
  --receiver reference-receiver \
  --seed demo
pnpm lab report
```
