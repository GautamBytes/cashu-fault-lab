# NIP-61 nutzap recovery

The opt-in `nip61-recovery-v1` suite exercises actual Nostr WebSocket delivery and
durable receiver subprocesses. It tests duplicate relay delivery, two concurrent
receiver workers, SIGKILL after a successful swap before local credit/history,
swap response loss, and a lost relay acknowledgement after history publication.

```bash
pnpm lab nutzap list
pnpm lab nutzap matrix --seed demo --output artifacts/nutzap-matrix.json
pnpm lab nutzap run crash-after-swap --seed demo --output artifacts/nutzap.json
pnpm lab nutzap replay artifacts/nutzap.json --seed demo
```

The default uses a simulated mint and is explicitly labeled `simulated`. The real
relay protocol, signed Nostr events, SQLite persistence, separate receiver processes,
and SIGKILL are exercised in this mode; fake Cashu signatures are not cryptographic
interoperability evidence.

## Funded verification

```bash
pnpm test:nutzap:funded
```

Requires Node 24 and Docker. The script starts a uniquely named stack using the
repository's pinned Nutshell and Redis images, selects a loopback port, runs all
five cases, and removes only that stack and its volumes. Nutshell uses FakeWallet
Lightning funding; no real sats are required. Missing infrastructure fails the lane.
The funded mode uses cashu-ts 4.7.2 for actual P2PK proof creation, DLEQ validation,
swap, NUT-09 output recovery, and NUT-07 proof states.

For an already-running **disposable** mint, use:

```bash
pnpm lab nutzap run crash-after-swap --seed demo \
  --mint-url http://127.0.0.1:3358 --output artifacts/nutzap-funded.json
pnpm lab nutzap replay artifacts/nutzap-funded.json --seed demo \
  --mint-url http://127.0.0.1:3358
```

The provided mint must automatically pay the lab's mint quotes. The harness creates
test keys and destroys its temporary wallet journal on exit; never fund these keys
with real value. External origins, redirects, complex P2PK conditions, non-sat units,
and more than 64 proofs are outside this initial profile.

## Recovery boundary

The receiver verifies the signed kind:10019 and kind:9321 events, exact advertised
mint, recipient, separate P2PK key, basic SIG_INPUTS lock, unit, and proof uniqueness.
The funded backend verifies DLEQ before preparing a swap. Incoming relay queries use
recipient `#p` and mint `#u` filters, not the recipient as event author.

Before any mint mutation, a SQLite transaction reserves each mint/proof identity
and persists the exact prepared output secrets, blinding data and fees. Concurrent
workers adopt the same saved plan. After a crash or ambiguous response, the receiver
restores those outputs. It checks their identities and value before atomically
committing one credit and an immutable NIP-60 token/history outbox. Publication
acknowledgements are recorded individually; retries use identical signed event IDs.
PENDING inputs remain pending. SPENT inputs with no recoverable saved outputs remain
blocked, never credited. Partial publication remains incomplete until retry succeeds.

Concurrency covers two processes sharing **one wallet journal**, as cooperating
workers do. Independent devices with separate databases, upstream wallet adoption,
public-relay discovery, key rotation, NIP-65 sender read-relay discovery and custom
external adapters are future work. The five scenarios are lab receiver evidence,
not external wallet certification. The existing wallet doctor remains read-only.

## Evidence

The oracle compares source/output mint states, the journal's credit count, conserved
value after fees, and token/history events independently fetched from both relays.
It verifies that redemption history references the nutzap and the created token,
that its amount/unit/direction match the credited payment, and that the published
token contains the exact saved outputs for the correct mint and unit. Events fetched
from relays must satisfy the requested filters and match the durable outbox IDs.
The crash case requires observed SIGKILL, spent inputs and zero credit at the crash
boundary. The concurrent case gates both workers at prepare to force an actual race.

Reports contain amounts, counts, invariant results, mode, implementation labels and
a domain-separated seed hash. They contain no keys, proof secrets, ciphertext or raw
prepared requests. Replay requires the original seed and mode and compares semantic
evidence; fresh keys/proofs/event ciphertext need not produce identical wire bytes.
Hashes establish local consistency, not authenticated provenance. Replay of a funded
report requires an explicit disposable mint URL. Matrix reports are summaries; use a
single-scenario report with `nutzap replay`.

The tests include canaries for duplicate credit, changed value, missing relay history,
invalid recovered outputs, pending inputs, report tampering, and incorrect seeds.
Run the Docker-free lane with `pnpm test:nutzap`. The funded lane also checks invalid
input DLEQ rejection without spending and replay with fresh proofs.

Sources: [NIP-61](https://github.com/nostr-protocol/nips/blob/master/61.md),
[NIP-60](https://github.com/nostr-protocol/nips/blob/master/60.md),
[NUT-09](https://github.com/cashubtc/nuts/blob/main/09.md),
[NUT-11](https://github.com/cashubtc/nuts/blob/main/11.md),
[NUT-12](https://github.com/cashubtc/nuts/blob/main/12.md).
