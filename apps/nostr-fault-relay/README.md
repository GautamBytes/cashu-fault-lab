# @cashu-fault-lab/nostr-fault-relay

Programmable NIP-01 Nostr relay that injects configurable faults for NIP-17 delivery testing.

## Purpose

Implements EVENT publishing, REQ subscription with filtering, and CLOSE/EOSE relay semantics, with injectable fault rules. Controllable at runtime via `NostrFaultControl`.

## Fault actions

| Action              | Description                          |
| ------------------- | ------------------------------------ |
| `duplicate_publish` | Duplicate an EVENT response          |
| `drop_ok`           | Suppress the OK acknowledgement      |
| `delay_history`     | Delay REQ history results            |
| `reorder_history`   | Reorder history results              |
| `disconnect`        | Force-close the WebSocket connection |

## Tests

```bash
pnpm --filter @cashu-fault-lab/nostr-fault-relay test
```
