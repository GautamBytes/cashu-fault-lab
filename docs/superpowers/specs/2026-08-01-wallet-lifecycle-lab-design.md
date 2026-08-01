# Wallet Lifecycle Fault Lab Design

**Date:** 2026-08-01
**Status:** Approved in conversation
**Branch:** `codex/wallet-lifecycle-v1`

## 1. Outcome

Cashu Fault Lab gains a `wallet-lifecycle-v1` suite that deliberately interrupts minting,
swapping, sending, receiving, restoring, reconciling, and Lightning melting. The suite proves
that every logical operation has at most one economic effect and that every satoshi remains in
an evidenced account: available, reserved, transferred, externally paid, charged as a fee, or
recoverable.

The lifecycle suite lives in the existing monorepo but does not reuse the delivery-specific
state model. It shares only infrastructure whose semantics are genuinely common: adapter
discovery, authenticated control APIs, fault injection, deterministic histories, replay,
reports, Docker fixtures, and CI.

## 2. Scope

### Included

- NUT-04/NUT-23 BOLT11 mint quote and issuance flows.
- NUT-03 swaps, including input fees and interrupted output recovery.
- Cashu token export/send and import/receive balance effects.
- NUT-05/NUT-23 synchronous and asynchronous BOLT11 melts.
- NUT-08 fee-return outputs.
- NUT-07 proof-state reconciliation.
- NUT-09 signature restoration.
- NUT-13 deterministic wallet restoration where supported.
- NUT-19 exact-request replay where advertised.
- NUT-20 mint-quote locking where advertised.
- cashu-ts and CDK wallet implementations.
- Nutshell and mintd test mints.
- Fake-value pull-request tests and a local Lightning regtest release lane.

### Excluded

- Mainnet, public testnet, or real-money operation.
- Production wallet user interfaces.
- NIP-60 relay diagnosis, repair, or wallet-event reconciliation.
- New Cashu protocol extensions.
- Treating an unsupported optional NUT as a passing result.

## 3. Repository boundary

The existing delivery packages continue to own Point 4. New lifecycle packages own Point 2:

```text
packages/
  wallet-lifecycle-core/       Pure operation identities and state transitions
  wallet-lifecycle-contract/   Language-neutral adapter contract and validation
  wallet-lifecycle-oracle/     Independent value and effect oracle
  wallet-lifecycle-runner/     Seeded scenarios, recovery and replay
scenarios/
  wallet-lifecycle/
adapters/
  cashu-ts/                    Implements both delivery and lifecycle contracts
  cdk/                         Implements both delivery and lifecycle contracts
```

The lifecycle oracle must not import cashu-ts, CDK, adapter persistence, mint code, or the
delivery oracle. It consumes only normalized observations from adapters, mints, the fault
gateway, and the lab-controlled Lightning probe.

## 4. Logical operation identity

Every economic action has a runner-generated 128-bit `operationId` encoded as 22-character
base64url without padding. The following identity is immutable:

```text
operationId + kind + normalized mint URL + unit + intentHash
```

Operation kinds are `mint`, `swap`, `send`, `receive`, `melt`, `restore`, and `reconcile`.
Adapters must durably persist identity and the prepared protocol material before the first
request that can create an economic effect.

The state machine is:

```text
created -> prepared -> submitted -> succeeded
                              \-> ambiguous -> reconciling -> succeeded
                                                       \-> failed_definitive
                                                       \-> recovery_blocked
```

`failed_definitive` is valid only with evidence that inputs remain unspent or the quote was
not paid. A timeout, disconnect, crash, stale response, or malformed response is `ambiguous`,
not failure.

## 5. Durable journal

Each adapter persists, before side effects:

- Operation identity and phase.
- Hashed quote and external-request identities.
- Exact method, normalized path, and request-body digest.
- Prepared input proof identifiers and output-plan hash.
- Amount, input fee, fee reserve, actual fee, and returned change.
- Attempt count and recovery mechanism.
- Monotonic quote observations.
- Sanitized terminal evidence.

Raw proof secrets, wallet seeds, quote IDs, NUT-20 private keys, signatures, payment preimages,
and complete request bodies must never be emitted in reports or ordinary logs.

## 6. Recovery order

For an ambiguous output-producing request, adapters recover in this order:

1. Replay the exact method, path, and body when the mint advertises the endpoint through NUT-19.
2. Query the corresponding quote state.
3. Query NUT-07 input states.
4. Restore the exact prepared blinded outputs through NUT-09.
5. Keep the operation `recovery_blocked` if the available protocol evidence cannot prove a safe
   terminal state. Never create a fresh output plan or release possibly consumed inputs.

For a melt, `PENDING` remains reserved and is polled. `PAID` requires independent Lightning
settlement evidence plus recovered NUT-08 change. `UNPAID` permits input release only after
NUT-07 reports every input `UNSPENT`.

## 7. Value oracle

The oracle maintains double-entry transfers between typed accounts:

- External funding.
- Wallet available value.
- Wallet reserved value.
- Transfer in flight.
- Receiver available value.
- Lightning settlement.
- Mint input fees.
- Lightning fees.
- Recoverable value.

Every posting has an immutable `effectId`, operation ID, unit, amount, source account, and
destination account. Re-observing an identical effect is idempotent; reusing an effect ID with
different data is a safety violation.

Safety invariants are checked after every observation:

- No account becomes negative.
- No operation identity, prepared request digest, or output plan changes.
- No proof identifier has two owners.
- No logical operation produces two economic effects.
- No Lightning invoice receives more than one settlement.
- Mint quote `amount_paid`, `amount_issued`, and `updated_at` never regress.
- `amount_issued` never exceeds `amount_paid`.
- Pending or ambiguous inputs never return to available value.
- Succeeded output-producing operations have durable or restored outputs.
- Succeeded melts have one payment effect and correctly accounted change and fees.

After faults stop, liveness requires each operation to become `succeeded`,
`failed_definitive`, or `recovery_blocked` with a stable reason. A required release scenario
cannot pass with `recovery_blocked`.

## 8. Adapter contract

The lifecycle contract is independently versioned so delivery-only adapters remain compatible.
It exposes:

```text
GET  /v1/lifecycle/capabilities
POST /v1/lifecycle/reset
POST /v1/lifecycle/operations
POST /v1/lifecycle/operations/{operationId}/resume
GET  /v1/lifecycle/operations/{operationId}
GET  /v1/lifecycle/wallet
GET  /v1/lifecycle/evidence
```

The operation request is a closed discriminated union. Responses are size-bounded, strictly
validated, and contain stable error codes. `resume` continues the persisted operation; it does
not create another logical operation.

Capabilities declare operations, NUTs, durability, supported mints, recovery mechanisms, and
crash boundaries. Missing functionality is `not_applicable`; capability misrepresentation is a
failure.

## 9. Fault model

The semantic HTTP gateway identifies requests by operation ID, method, normalized Cashu path,
and attempt. Rules can:

- Drop before forwarding.
- Delay before forwarding or before returning.
- Forward and drop the response.
- Reset the connection.
- Return a duplicated or stale prior response.
- Corrupt or truncate a response.
- Reorder polling responses.

Crash controls cover every durable/network boundary: before journal persistence, after
preparation, after request dispatch, after mint response, after output persistence, after
balance posting, and before returning control evidence.

## 10. Security

- Control APIs bind to loopback and require bearer authentication.
- Redirects are disabled and adapter egress is restricted to configured test origins.
- Non-loopback mint endpoints require an explicit unsafe-test-network flag and HTTPS.
- Mainnet and public Lightning network identifiers are rejected.
- Quote IDs are treated as credentials; NUT-20 is used where advertised.
- Seeds and replay seeds use separate derivation domains.
- Evidence uses run-scoped hashing and redaction before persistence.
- Inputs have strict byte, count, integer, URL, and time bounds.
- Adapters are untrusted; release evidence is corroborated by mint and Lightning probes.

## 11. Test and release lanes

- **Unit:** schemas, state transitions, accounting, redaction, and property tests.
- **Integration:** durable journals, concurrent resume, process restarts, and semantic faults.
- **Funded:** cashu-ts and CDK against both Nutshell and mintd fake-value backends.
- **Regtest:** local Bitcoin and Lightning only, with an independently queried invoice sink.

Release qualification requires two distinct wallet implementation identities, both test mints,
all required lifecycle scenarios, exact replay evidence, no secret leakage, and no skipped
required invariant.

## 12. Developer experience

```text
cashu-fault-lab lifecycle run mint-response-lost --adapter cashu-ts --mint nutshell --seed 42
cashu-fault-lab lifecycle matrix --profile wallet-lifecycle-v1
cashu-fault-lab lifecycle replay artifacts/failure.json
cashu-fault-lab doctor --suite lifecycle
```

Every failure report contains the seed, minimized command trace, injected fault, component
versions, sanitized state transitions, failed invariant, and exact replay command.
