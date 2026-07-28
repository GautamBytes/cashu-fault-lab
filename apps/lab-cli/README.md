# @cashu-fault-lab/lab-cli

Main CLI binary (`cashu-fault-lab`) for running fault scenarios, compatibility matrices, and reports.

The v0.1 command below produces the checked-in, secret-redacted developer-preview example:

```bash
pnpm lab demo --seed cashu-fault-lab-v0.1.0-demo --artifact docs/examples/v0.1.0-demo.json --report docs/examples/v0.1.0-demo.html
```

## Commands

| Command              | Description                                  |
| -------------------- | -------------------------------------------- |
| `up`                 | Start local lab services (Docker Compose)    |
| `run <scenario>`     | Execute a fault-injection scenario           |
| `replay <artifact>`  | Deterministically replay a failure artifact  |
| `matrix`             | Run the sender/receiver compatibility matrix |
| `report [artifact]`  | Render a redacted report (JSON/JUnit/HTML)   |
| `ls`                 | List all available scenarios                 |
| `inspect <scenario>` | Pretty-print a scenario file                 |
| `gen-id`             | Generate a random 128-bit ProtocolId         |

## Examples

```bash
# Run with verbose progress
pnpm lab run scenarios/retry/response-lost.json --verbose

# Compatibility matrix for delivery-v1 profile
pnpm lab matrix --profile delivery-v1 --verbose

# Provenance-aware release gate
pnpm lab matrix --profile delivery-v1 \
  --release-policy spec/release-policy.json \
  --release-suite spec/release-suite.json

# Generate JUnit report
pnpm lab report artifacts/latest.json --format junit --output result.xml
```

`--min-passes` remains a developer convenience. `--release-policy` validates the policy before
starting adapters. It implicitly loads `spec/release-suite.json` unless `--release-suite` selects
another strict suite, executes every named scenario for every candidate pair, and exits nonzero
with stable rejection codes when identity, evidence, provenance, or invariant requirements fail.

## Key exports

- `runCli` — entry point accepting argv and injectable dependencies
- `LabRuntime` — interface for swappable runtime implementations
- `CliIo` / `CliOutcome` — IO abstraction and exit code type

## Tests

```bash
pnpm --filter @cashu-fault-lab/lab-cli test
```
