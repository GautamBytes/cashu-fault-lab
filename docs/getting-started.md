# Getting started

Run the public deterministic demo first. It verifies the published package, exercises the checked-in fault scenario, and writes reviewable evidence without requiring a local checkout.

## Requirements

- Node.js 24
- Docker with Compose v2
- Enough local capacity to start the demo wallet, mint, receiver, and lab services

## 1. Check the environment

```bash
npx --yes cashu-fault-lab@0.2.0 doctor
```

The doctor reports ten prerequisite checks. Resolve any failed check before starting the demo.

## 2. Run the verified demo

```bash
npx --yes cashu-fault-lab@0.2.0 demo --output ./cashu-fault-lab-evidence
```

The command downloads the published package, starts the Docker stack, runs the stable `retry-safe-v0.1.0` seed, writes JSON, JUnit, HTML, and screenshot evidence, then removes the demo resources.

## 3. Verify the result

Look for `demo passed`, 15 passing invariants, three not-applicable observations, and zero cleanup failures. Open the generated HTML report and screenshots to inspect the run rather than relying on terminal output alone.

The deterministic demo is project-owned evidence, not independent interoperability certification. See [release status](/release-status) for the remaining validation work.

## Next paths

- [Integrate a wallet adapter](./adapters.md)
- [Understand the delivery profile](../spec/cashu-delivery-v1.md)
- [Review the wallet lifecycle](./wallet-lifecycle.md)
- [Inspect the architecture](/architecture)
