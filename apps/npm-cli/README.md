# Cashu Fault Lab CLI

Reproduce ambiguous Cashu payment delivery, test exact retries and collect redacted recovery
evidence without cloning the repository.

## Requirements

- Node.js 24
- Docker with Docker Compose

## Quick start

```bash
npx cashu-fault-lab doctor
npx cashu-fault-lab demo
```

The demo starts an isolated stack, loses an HTTP response, retries the exact delivery and checks
that recovery converges to one durable credit. It writes redacted JSON and HTML evidence, then
removes the stack unless you pass `--keep`.

Useful commands:

```bash
npx cashu-fault-lab ls
npx cashu-fault-lab inspect retry/response-lost
npx cashu-fault-lab adapter init --language typescript --name my-wallet
npx cashu-fault-lab adapter preflight --adapters adapter-manifest.json
npx cashu-fault-lab adapter preview --adapters adapter-manifest.json --sender my-wallet --receiver my-wallet
```

Adapter preflight and preview accept loopback HTTP origins only. Preview runs response-loss and
duplicate-delivery checks for one exact pair, starts its local fault gateway automatically, and
writes a redacted feedback bundle. The bundle is diagnostic evidence, not release qualification.

Cashu Fault Lab 0.1 is an experimental developer preview, not a certification that a wallet is
production-safe.

Full documentation: <https://cashu-fault-lab.vercel.app/>

Source and issues: <https://github.com/GautamBytes/cashu-fault-lab>
