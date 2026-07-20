# @cashu-fault-lab/http-fault-gateway

Programmable HTTP reverse proxy that injects semantic transport faults between sender and receiver.

## Purpose

Sits between the sender and receiver/mint and supports fault injection at three phases. Exposes a REST control API (`/__faults/v1/`) for runtime rule configuration.

## Fault actions

| Action      | Phase                    | Description                       |
| ----------- | ------------------------ | --------------------------------- |
| `drop`      | before_forward / after_* | Terminate the request or response |
| `delay`     | before_forward / after_* | Inject latency                    |
| `duplicate` | before_forward only      | Duplicate the outbound request    |
| `reorder`   | before_forward only      | Reorder concurrent requests       |
| `status`    | before_forward / after_* | Return a synthetic HTTP status    |

## Fault phases

- `before_forward` — before the request reaches the downstream
- `after_downstream_commit` — after the downstream commits but before the response
- `after_downstream_response` — after the downstream response is received

## Control API

| Method   | Route                   | Purpose                   |
| -------- | ----------------------- | ------------------------- |
| `POST`   | `/__faults/v1/rules`    | Add a fault rule          |
| `DELETE` | `/__faults/v1/rules`    | Clear all rules           |
| `POST`   | `/__faults/v1/reset`    | Reset rules and counters  |
| `GET`    | `/__faults/v1/evidence` | Snapshot gateway counters |

All routes require `Authorization: Bearer <token>`.

## Tests

```bash
pnpm --filter @cashu-fault-lab/http-fault-gateway test
```
