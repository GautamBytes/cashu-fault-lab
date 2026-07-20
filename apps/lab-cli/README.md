# @cashu-fault-lab/lab-cli

Main CLI binary (`cashu-fault-lab`) for running fault scenarios, compatibility matrices, and reports.

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

# Generate JUnit report
pnpm lab report artifacts/latest.json --format junit --output result.xml
```

## Key exports

- `runCli` — entry point accepting argv and injectable dependencies
- `LabRuntime` — interface for swappable runtime implementations
- `CliIo` / `CliOutcome` — IO abstraction and exit code type

## Tests

```bash
pnpm --filter @cashu-fault-lab/lab-cli test
```
