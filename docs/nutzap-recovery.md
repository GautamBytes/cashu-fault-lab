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

Requires Node 24, Rust 1.97 and Docker on macOS or Linux. The script builds the native
CDK receiver once and runs separate Nutshell and mintd stacks in sequence. Each uses a
unique Compose project, a dynamically selected loopback port and fake Lightning funding.
The script removes only its own stacks and volumes; no real sats are required. Missing infrastructure fails the lane.
The funded mode uses cashu-ts 4.7.2 for actual P2PK proof creation, DLEQ validation,
swap, NUT-09 output recovery, and NUT-07 proof states.

## Two-mint funded matrix (unreleased)

The source checkout runs all twenty scenarios on each mint, including the cashu-ts/CDK
race and crashes in both directions. Every scenario is replayed with fresh proofs.
The existing installed-package check also runs CDK crash/recovery and replay against
each mint outside the monorepo. Both lanes must pass; unavailable infrastructure or
an unexpected mint implementation fails the lane instead of becoming simulated evidence.

| Mint     | Pinned version | Compose source                       |
| -------- | -------------- | ------------------------------------ |
| Nutshell | 0.20.2         | `infra/compose/nutshell.compose.yml` |
| mintd    | 0.17.3         | `infra/compose/cdk-mint.compose.yml` |

Both images are digest-pinned in those files. The full command runs 40 scenario/mint
combinations plus replay and invalid-DLEQ canaries. To select one lane:

```bash
pnpm test:nutzap:funded --mint nutshell
pnpm test:nutzap:funded --mint mintd
```

Reports are saved with private file permissions under
`artifacts/nutzap-funded/<run-id>/<mint>/<scenario>.json`; CI uploads them separately
for each mint. Reports record the bounded `/v1/info` software/version string in
`implementations.mint`. The test harness requires the expected version for its pinned
image. This string is self-reported metadata, not authenticated build provenance.

Replay checks the target mint implementation before creating new proofs and compares
it again after execution. The port can change between runs. Older funded artifacts
with a generic mint label must be regenerated; simulated replay remains supported.
This verifies recovery with two mint implementations, not transfers between mints or
certification of external wallet products. The default simulated matrix contains thirteen scenarios; seven native CDK cases require funded mode.

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

The `independent-*` cases use one receiver implementation. All cases are bounded
recovery tests using fresh, disposable journals and two configured loopback relays.
The post-spend cases below extend this to one partial spend from a previously synchronized
receipt. This does not implement general wallet synchronization or migrate existing databases.
Recovery requires the winner's private journal to survive the crash: permanent loss
of unpublished output secrets is outside the guarantee. The scenarios provide lab
receiver evidence, not certification of independently developed wallet products.
Upstream wallet adoption, public-relay discovery, NIP-65 sender
read-relay discovery and custom external adapters remain future work. The existing
wallet doctor remains read-only.

## Post-spend wallet recovery (unreleased)

These two cashu-ts scenarios start with a redeemed nutzap in two separate wallet journals,
spend 4 sats from that balance, and reconnect the second wallet. The spender reissues all
proofs from the old token into payment and change outputs. A separate recipient redeems
the payment at the mint, so evidence includes actual settlement and fees.

| Scenario                       | Fault and required recovery                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `post-spend-stale-relay`       | Relays first return only the obsolete token, then a deletion without its replacement, then a replacement without the deletion. Reverse one relay's result order and require the same remaining balance. |
| `post-spend-publication-crash` | SIGKILL the spender after its first replacement-token publication. Restart from its journal, publish the original saved outbox, then exercise the same stale/reordered relay sequence.                  |

```bash
pnpm lab nutzap run post-spend-stale-relay --seed demo
pnpm lab nutzap run post-spend-publication-crash --seed demo --output artifacts/post-spend.json
pnpm lab nutzap replay artifacts/post-spend.json --seed demo
pnpm test:nutzap:funded
```

The last command runs both new cases and replay against Nutshell and mintd; CI also tests
crash recovery and replay through the installed npm CLI. The simulated fixture retains
10 sats after spending 4 from a 15-sat redemption with a 1-sat swap fee; funded reports
use the actual mint fees rather than assuming those amounts.

An immutable redemption receipt records the original economic credit. Current proofs
record the spendable balance separately. Prepared spend inputs stay reserved. Exact
output secrets/blinding data are saved before swapping; the replacement token, NIP-09
deletion and outgoing history are saved before publication. Retry uses the same signed
event IDs. Retired token IDs survive journal restart, and duplicate nutzap delivery does
not recreate the original balance.

Reconciliation verifies event signatures and wallet ownership, NIP-44 payloads, mint/unit,
the replacement's `del` reference, unique proofs, DLEQ and current mint proof states.
History is informational, not balance authority. Conflicting replacements, pending proofs,
missing replacement evidence or unavailable mint checks cannot establish spendable value.
The journal exposes zero verified spendable value with `awaiting-peer` when evidence is
insufficient; this does not mean the missing funds are proven lost. A prepared local spend
must recover before synchronization can release its reservation.

Reports keep the original redemption snapshot in the existing evidence fields and add
`postSpend` for final balances, payment/change/recipient proof states, fees, relay fault
observations and publication recovery. Each wallet's balance is a view of the same money;
those two balances must not be added together. Reports retain no proof secrets or keys.

Scope is one partial spend after both journals synchronized the initial redemption, with
the spender's private journal surviving restart. This is not arbitrary multi-spend history
reconstruction or recovery of a permanently lost journal. The native CDK cases below
apply the same bounded scope to two different receiver implementations.
The fault relays deliberately retain obsolete events to test stale responses; successful
synchronization does not depend on a relay honoring a deletion request.

## Cross-language post-spend recovery (unreleased)

Four funded cases extend the same partial-spend faults to Rust/CDK and cashu-ts:

| Scenario                                | Spender  | Reconnecting wallet | Fault                                                                          |
| --------------------------------------- | -------- | ------------------- | ------------------------------------------------------------------------------ |
| `cdk-post-spend-stale-relay`            | CDK      | cashu-ts            | Stale tokens and reordered deletion/replacement events                         |
| `cdk-post-spend-publication-crash`      | CDK      | cashu-ts            | SIGKILL after the first replacement publication, followed by stale relay views |
| `cdk-peer-post-spend-stale-relay`       | cashu-ts | CDK                 | Stale tokens and reordered deletion/replacement events                         |
| `cdk-peer-post-spend-publication-crash` | cashu-ts | CDK                 | SIGKILL after the first replacement publication, followed by stale relay views |

CDK prepares and restores its own blinded outputs, persists its own spend reservation and
signed outbox, and sends its own mint and relay requests. Its reconciler validates signed
NIP-60 transitions, persistent deletion tombstones, DLEQ, and mint proof states. Unverified
or ambiguous state cannot establish a spendable balance. The harness only controls fault
ordering and reads journals; it never writes CDK wallet state or performs CDK spending.

Both wallets start synchronized with the initial receipt. After one partial spend, their
balances must equal the verified change, while a separate recipient redeems the payment.
The original credit remains immutable. Replay uses fresh proofs and compares semantic
evidence, including the spender implementation, observed native spend/sync checkpoints,
private distinct journals, and the actual crashed process. The installed CLI exercises
both publication-crash directions and replay against both mints.

```bash
pnpm lab nutzap run cdk-post-spend-publication-crash --seed demo \
  --mint-url http://127.0.0.1:3358 \
  --cdk-receiver "$PWD/adapters/cdk/target/debug/cdk-nutzap-receiver" \
  --output artifacts/cdk-post-spend.json
pnpm lab nutzap replay artifacts/cdk-post-spend.json --seed demo \
  --mint-url http://127.0.0.1:3358 \
  --cdk-receiver "$PWD/adapters/cdk/target/debug/cdk-nutzap-receiver"
```

These cases require the same surviving private journals and one-spend scope described above.
They do not claim arbitrary history reconstruction or external wallet adoption.

## Native CDK interoperability

The funded `cdk-*` cases pair the TypeScript/cashu-ts receiver with a separately
implemented Rust receiver. Rust owns its SQLite journal, HTTP mint requests, CDK
0.17.3 blinding/P2PK/DLEQ operations, NUT-09 restoration, WebSocket connections, and
NIP-60 signing/encryption through nostr 0.45.5. It does not call the TypeScript
receiver or ask the harness to redeem or publish on its behalf. The harness controls
checkpoint ordering and observes results; it reads both journals without modifying
them and independently queries the mint and relays.

| Scenario                    | Required behavior                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `cdk-concurrent`            | Both implementations prepare separate outputs and race; exactly one swap succeeds and both journals converge |
| `cdk-crash-after-swap`      | Force CDK to win, SIGKILL it before credit/history, then recover from its saved blinding data                |
| `cdk-peer-crash-after-swap` | Force cashu-ts to win and crash; CDK waits for and verifies the recovered wallet transition                  |

Both crash directions and the concurrent case are replayed with fresh proofs in the
funded test lane. That lane also checks native DLEQ rejection without spending and
CDK crash/replay through the npm-installed CLI outside the repository.
Evidence requires the expected crashed process, separate private
journals/output plans, one economic credit, matching NIP-60 events and conserved
value. Receiver keys enter the Rust process through stdin; reports contain no keys,
proof secrets or blinding data. Mint/relay responses and process messages are bounded.

To run against an already-running disposable, automatically funded mint:

```bash
cargo build --locked --manifest-path adapters/cdk/Cargo.toml --bin cdk-nutzap-receiver
pnpm lab nutzap run cdk-crash-after-swap --seed demo \
  --mint-url http://127.0.0.1:3358 \
  --cdk-receiver "$PWD/adapters/cdk/target/debug/cdk-nutzap-receiver" \
  --output artifacts/nutzap-cdk.json
pnpm lab nutzap replay artifacts/nutzap-cdk.json --seed demo \
  --mint-url http://127.0.0.1:3358 \
  --cdk-receiver "$PWD/adapters/cdk/target/debug/cdk-nutzap-receiver"
```

`nutzap list` includes all seventeen cases. The default `nutzap matrix` still runs the
ten cases that support simulation. Supplying `--cdk-receiver` and `--mint-url`
adds the seven native cases. Missing native infrastructure fails explicitly; it
never falls back to simulation. The npm CLI requires a separately built receiver
binary. `CFL_NUTZAP_CDK_RECEIVER` can select an existing binary for the funded test
script; otherwise that script builds it and respects `CARGO_TARGET_DIR`.

These are two lab-maintained receivers built on different SDKs. They are not evidence
of upstream wallet adoption or certification of an external wallet application.

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

## Receiving-key rotation (unreleased)

These three cases rotate the recipient's separate P2PK receiving key once while retaining
the same Nostr identity, mint and sat unit. They exercise cashu-ts receivers; native CDK
key rotation and arbitrary key histories are outside this profile.

| Scenario                        | Required recovery                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key-rotation-delayed`          | Hide an old-key nutzap until after rotation, then redeem it with the retained key. Redeem a second payment locked to the newly advertised key.                      |
| `key-rotation-crash-after-swap` | SIGKILL the old-key receiver after its swap succeeds but before credit/history. Reopen private state, restore outputs and credit once.                              |
| `key-rotation-missing-key`      | Withhold the old private key. Require `recovery-blocked`, zero credit, no wallet publication and unspent inputs. Import the matching backup and retry successfully. |

Every case gives the sender a newer signed kind:10019 advertisement followed by a stale
relay answer after reopening its cache. The sender keeps the newest known advertisement;
equal timestamps use the lowest event ID. A sender that has never seen the new advertisement
cannot infer that rotation occurred. The receiver validates delayed payments against its
retained signed advertisement, so the sender's current selection does not discard old keys.

The private SQLite key store commits the new secret before its advertisement is published.
Both the key store and wallet journal must survive a crash. Wrong private keys, invalid
signatures, another recipient, changes to mint trust, unsupported units and a third key
are rejected. A missing key blocks before mint access. Restoring a backup does not roll
back the active advertisement. Private state uses mode 0600 inside a temporary directory
and is removed after the run; reports contain no private keys, bearer proofs or output secrets.

Each case retries both payments through receiver subprocesses. The report's base evidence
captures the old-key redemption before the new payment; `rotation.newPayment` verifies
the second payment separately. The oracle requires two total credits, the combined
balance after both swap fees, unspent outputs, and identical token/history IDs after retries.
All three cases run and replay with fresh proofs against Nutshell and mintd. The installed
CLI also runs and replays the rotation crash case outside the monorepo on each mint.

```bash
pnpm lab nutzap run key-rotation-crash-after-swap --seed demo --output artifacts/key-rotation.json
pnpm lab nutzap replay artifacts/key-rotation.json --seed demo
pnpm lab nutzap run key-rotation-missing-key --seed demo
pnpm test:nutzap:funded
```

This is a bounded lab recovery policy. [NIP-61](https://github.com/nostr-protocol/nips/blob/master/61.md)
advertises a separate receiving key; it does not specify a complete rotation lifecycle.
The private history here is not a new NIP-60 wire format or a production wallet key-backup
service. Permanent loss of the old key before redemption remains unrecoverable in this profile.
