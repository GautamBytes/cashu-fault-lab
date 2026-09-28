# Cashu Fault Lab CLI

Test Cashu payment retries and collect redacted recovery evidence without cloning the repository.

## Requirements

- Node.js 24
- Docker with Docker Compose

## Quick start

```bash
npx --yes cashu-fault-lab@0.3.0 doctor
npx --yes cashu-fault-lab@0.3.0 demo
```

The demo retries a lost HTTP response and checks for one durable credit. It writes redacted
JSON/HTML evidence and removes its isolated stack unless you pass `--keep`.

Useful commands:

```bash
npx --yes cashu-fault-lab@0.3.0 ls
npx --yes cashu-fault-lab@0.3.0 inspect retry/response-lost
npx --yes cashu-fault-lab@0.3.0 adapter init --language typescript --name my-wallet
npx --yes cashu-fault-lab@0.3.0 adapter preflight --adapters adapter-manifest.json
npx --yes cashu-fault-lab@0.3.0 adapter preview --adapters adapter-manifest.json --sender my-wallet --receiver my-wallet
npx --yes cashu-fault-lab@0.3.0 wallet-doctor check artifacts/wallet-doctor/capture.json
npx --yes cashu-fault-lab@0.3.0 nutzap run crash-after-swap --seed demo
```

Adapter preflight and preview accept loopback HTTP origins only. Preview runs response-loss and
duplicate-delivery checks for one exact pair, starts its local fault gateway automatically, and
writes a redacted feedback bundle. The bundle is diagnostic evidence, not release qualification.

Version 0.3 adds NIP-61/NIP-60 recovery, key rotation, NIP-65 routing and NUT-26 checks.
Nutzap runs simulate a mint by default; funded CDK cases need separately built Rust binaries.
Strict conformance exposes known SDK gaps.

Cashu Fault Lab 0.3 is an experimental developer preview, not a certification that a wallet is
production-safe.

Full documentation: <https://www.cashulabs.online/>

Source and issues: <https://github.com/GautamBytes/cashu-fault-lab>
