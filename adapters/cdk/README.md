# cashu-fault-lab-cdk-adapter

Rust adapter server wrapping the `cdk` crate that exposes the lab's 7-route adapter contract.

## Purpose

Enables the CDK (Cashu Development Kit v0.17.3) to participate in fault-injection scenarios as a funded sender. Built with Axum and `cdk-sqlite` for persistence.

## Routes

| Method | Route                | Purpose                                          |
| ------ | -------------------- | ------------------------------------------------ |
| `GET`  | `/v1/capabilities`   | Declare implementation identity                  |
| `POST` | `/v1/reset`          | Reset and fund wallet from fake mint             |
| `POST` | `/v1/requests`       | Sender-only — returns 501 N/A                    |
| `POST` | `/v1/send`           | Reserve proofs, construct payload, send via HTTP |
| `GET`  | `/v1/deliveries/:id` | Read sender-observed receipt                     |
| `GET`  | `/v1/ledger`         | Sender-only — returns 501 N/A                    |
| `GET`  | `/v1/proofs`         | Return proof-set hash and state                  |

## Build

```bash
cargo build --manifest-path adapters/cdk/Cargo.toml
```

## Run

```bash
export CASHU_FAULT_LAB_CONTROL_TOKEN=lab-only-token
export CASHU_FAULT_LAB_CDK_MINT_URL=http://127.0.0.1:3338
cargo run --manifest-path adapters/cdk/Cargo.toml
```

## Tests

```bash
cargo test --manifest-path adapters/cdk/Cargo.toml
```

## Current capabilities

| Evidence tier       | Status                         |
| ------------------- | ------------------------------ |
| T0 (codec)          | Supported                      |
| T1 (transport)      | Supported — funded HTTP sender |
| T2 (recovery)       | Not implemented                |
| T3 (durable credit) | Not implemented (sender-only)  |
