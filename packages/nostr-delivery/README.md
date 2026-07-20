# @cashu-fault-lab/nostr-delivery

Nostr gift-wrap tools and relay client for delivering Cashu tokens over NIP-17.

## Purpose

Implements the NIP-17 gift-wrap flow for Cashu delivery payloads: NIP-44 encryption, kind-1059 wrapping, seal verification, and inbox backfill. Also provides a WebSocket relay client for publishing events and querying history.

## Key exports

- **Gift-wrap** — `wrapDelivery`, `unwrapDelivery` (rumor → seal → gift-wrap)
- **Inbox** — `NostrDeliveryInbox` (subscribes to relay, unwraps received events)
- **Relay client** — `NostrRelayClient` (WebSocket publish/query)
- **Targets** — `decodeNip17Target`, `normalizeRelayUrl`

## Transport flow

```
Sender: payload → kind-14 rumor → kind-13 seal → kind-1059 gift-wrap → relay
Receiver: relay → kind-1059 filter → unwrap → verify seal → extract rumor → parse payload
```

## Dependencies

- `nostr-tools` — event signing, verification, NIP-44 encryption
- `ws` — WebSocket transport for relay communication

## Tests

```bash
pnpm --filter @cashu-fault-lab/nostr-delivery test
```
