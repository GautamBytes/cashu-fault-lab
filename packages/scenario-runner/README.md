# @cashu-fault-lab/scenario-runner

Deterministic fault-injection engine that executes JSON scenario scripts across reference and external wallet adapters.

## Purpose

Orchestrates sender/receiver pairs, injects transport faults (drop, delay, duplicate, reorder), records an immutable history timeline, and feeds observations to the oracle for invariant verification. Every run produces a replayable artifact.

## Key exports

- **ScenarioRunner** — core engine that runs `ScenarioSpec` commands
- **ScenarioDriver** — interface for pluggable sender/receiver pairs
- **Reference lanes** — `runReferenceHttpScenario`, `runReferenceNostrScenario`, `runReferenceCrashScenario`, `runReferenceSecurityScenario`
- **External adapter** — `ExternalAdapterScenarioDriver`, `HttpExternalFaultController`
- **Compatibility matrix** — `CompatibilityMatrix`, `runExternalDeliveryPair`
- **Replay** — `assertReplayableArtifact`, `minimizeFailingCommands` (delta-debugging)

## Scenario JSON schema

```json
{
  "name": "http-response-lost",
  "description": "Drops the first HTTP response. Verifies sender retry.",
  "commands": [
    {
      "type": "configure_fault",
      "target": "http",
      "rule": { "kind": "drop_response", "occurrence": 1 }
    },
    { "type": "send", "sender": "reference", "requestId": "AAECAwQFBgcICQoLDA0ODw" },
    { "type": "assert_quiescent" }
  ]
}
```

Command types: `configure_fault`, `send`, `restart`, `advance_time`, `clear_faults`, `assert_quiescent`.

## Tests

```bash
pnpm --filter @cashu-fault-lab/scenario-runner test
```
