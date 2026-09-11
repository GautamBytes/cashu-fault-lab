# NIP-61 nutzap recovery

The opt-in `nip61-recovery-v1` suite exercises actual Nostr WebSocket delivery and
durable receiver subprocesses. It tests duplicate relay delivery, two concurrent
receiver workers, SIGKILL after a successful swap before local credit/history,
swap response loss, and a lost relay acknowledgement after history publication.
It also tests two independent wallet databases racing to redeem the same nutzap,
including recovery after a process crash or both relays going offline.

```bash
pnpm lab nutzap list
pnpm lab nutzap matrix --seed demo --output artifacts/nutzap-matrix.json
pnpm lab nutzap run crash-after-swap --seed demo --output artifacts/nutzap.json
pnpm lab nutzap replay artifacts/nutzap.json --seed demo
pnpm lab nutzap run independent-crash-after-swap --seed demo \
  --output artifacts/nutzap-independent.json
pnpm lab nutzap replay artifacts/nutzap-independent.json --seed demo
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
eight scenarios, and removes only that stack and its volumes. Nutshell uses FakeWallet
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
workers sharing a journal adopt the same saved plan. After a crash or ambiguous response, the receiver
restores those outputs. It checks their identities and value before atomically
committing one credit and an immutable NIP-60 token/history outbox. Publication
acknowledgements are recorded individually; retries use identical signed event IDs.
PENDING inputs remain pending. SPENT inputs alone never establish a successful
redemption. Partial publication remains incomplete until retry succeeds.

## Independent wallet databases

These cases run two receiver subprocesses with separate private SQLite files and
separately prepared output secrets. Both use the same wallet identity and P2PK key.
The funded lane creates separate cashu-ts wallet instances; the crashed winner is
restarted with a fresh instance and its surviving journal.

| Scenario                       | Injected failure                                                   | Required recovery                                                                     |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `independent-concurrent`       | Both clients attempt the same swap before either publishes history | One swap succeeds; the other client imports the verified wallet transition            |
| `independent-crash-after-swap` | SIGKILL the successful receiver before local credit or publication | Restart restores its prepared outputs, then both journals converge                    |
| `independent-relay-outage`     | Both relay servers stop before concurrent redemption               | Restart the relays; retry publishes the durable outbox and synchronizes both journals |

The losing client remains `awaiting-peer` until it can retrieve the complete signed
kind:7375 token and kind:7376 redemption history. It verifies the wallet author,
signature, NIP-44 payloads, nutzap/token references, sender, mint, sat unit, amount
after fees, unique output proofs, spent source inputs and unspent outputs. The
funded mint port also checks output DLEQ. Conflicting histories, incomplete evidence
and relay failures cannot create a balance. A journal transaction prevents the same
output proofs from being counted again under another nutzap receipt.

Importing this transition replicates an existing balance: `credits` counts local
redemptions, while `balance` includes imported proofs. Reports require local credit
counts `[0, 1]` and equal balances in both journals. Those balances are two views of
the same money and must not be added together. Retries publish the original signed
events; they do not create another receipt.

This is a bounded recovery lab using fresh, disposable journals, two configured
loopback relays and one receiver implementation. It does not implement general
wallet synchronization after further spending or migrate existing wallet databases.
Recovery requires the winner's private journal to survive the crash: permanent loss
of unpublished output secrets is outside the guarantee. The scenarios provide lab
receiver evidence, not certification of independently developed wallet products.
Upstream wallet adoption, public-relay discovery, key rotation, NIP-65 sender
read-relay discovery and custom external adapters remain future work. The existing
wallet doctor remains read-only.

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
Independent-wallet evidence additionally requires distinct database files and output
plans, two swap attempts with exactly one success, one imported balance, matching
wallet event IDs, and an observed wait for peer evidence. The outage case requires
failed network probes while both servers are stopped. Tests also reject forged or
conflicting peer events, spent/invalid outputs and duplicate output accounting.
Run the Docker-free lane with `pnpm test:nutzap`. The funded lane also checks invalid
input DLEQ rejection without spending and replay with fresh proofs.

Sources: [NIP-61](https://github.com/nostr-protocol/nips/blob/master/61.md),
[NIP-60](https://github.com/nostr-protocol/nips/blob/master/60.md),
[NUT-09](https://github.com/cashubtc/nuts/blob/main/09.md),
[NUT-11](https://github.com/cashubtc/nuts/blob/main/11.md),
[NUT-12](https://github.com/cashubtc/nuts/blob/main/12.md).
