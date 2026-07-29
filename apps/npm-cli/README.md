# Cashu Fault Lab CLI

Run deterministic Cashu payment-delivery fault scenarios without cloning the repository.

## Requirements

- Node.js 24
- Docker with Docker Compose

## Quick start

```bash
npx cashu-fault-lab doctor
npx cashu-fault-lab demo
```

The demo starts an isolated local stack, injects a lost HTTP response, retries the exact
delivery, verifies recovery and writes redacted JSON and HTML evidence. The stack is removed
when the run finishes unless `--keep` is supplied.

Explore the bundled scenarios:

```bash
npx cashu-fault-lab ls
npx cashu-fault-lab inspect retry/response-lost
npx cashu-fault-lab validate retry/response-lost
```

Scaffold an adapter:

```bash
npx cashu-fault-lab adapter init --language typescript --name my-wallet
```

Documentation: <https://cashu-fault-lab.vercel.app/docs>

Source and issues: <https://github.com/GautamBytes/cashu-fault-lab>
