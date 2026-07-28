# Release Gate Integrity Design

## Status

Approved for implementation on `codex/release-gate-integrity` on 2026-07-28.
The user requested implementation to proceed without another design checkpoint.

## Objective

Make the strict release gate capable of accepting genuinely independent
evidence while remaining fail-closed for adapter self-claims. Bind the gate to
the exact release suite, aggregate suite results conservatively, prove the exact
fault rule and route used by each scenario, and correct stale preview materials.

The work starts from `origin/main`. It must preserve the atomic receiver
settlement transaction and release-suite realpath confinement already present
there. No changes from the stale `codex/release-hardening-v0-1` checkout are
transplanted wholesale.

## Evidence trust model

The oracle will replace the single run-wide observation confidence with
source-specific confidence:

```ts
type EvidenceSourceConfidence = Readonly<
  Partial<
    Record<
      'timeline' | 'receipt' | 'ledger' | 'proofs' | 'capabilities',
      'observed' | 'adapter_claimed'
    >
  >
>;
```

An invariant that passes with `derived` confidence is downgraded to
`adapter_claimed` when any evidence source it uses is adapter-claimed. A
derivation can never upgrade a weak source. Existing callers that do not supply
source confidence keep their current runner-observed behavior.

For an external adapter scenario:

- runner command history and a runner-controlled HTTP gateway are observed;
- receipts are observed only when the runner-controlled gateway recorded the
  exact delivery route; direct wallet responses remain adapter-claimed;
- ledger evidence is observed only when read through an independently
  configured ledger authority;
- mint proof evidence is observed only when read through an independently
  configured mint authority;
- capability declarations are directly recorded contract inputs and may be
  used with the runner's observed execution to enforce unsupported combinations;
- crash/restart history is observed only when the runner-owned controller
  executes the restart or verifies the armed crash and subsequent readiness.

The adapter manifest moves to schema version 2 and allows an optional
`evidence` object on each adapter registration:

```ts
interface EvidenceAuthorityRegistration {
  readonly url: string;
  readonly tokenEnv: string;
}

interface AdapterRegistration {
  readonly id: string;
  readonly url: string;
  readonly tokenEnv: string;
  readonly evidence?: {
    readonly ledger?: EvidenceAuthorityRegistration;
    readonly mint?: EvidenceAuthorityRegistration;
  };
}
```

Evidence authority origins must be loopback HTTP origins for local execution
and must differ from the adapter control origin. The runner calls only the
read-only ledger and proof routes on these clients. Version-2 manifests without
authorities remain valid for developer smoke matrices, but their evidence stays
`adapter_claimed` and cannot qualify under the strict policy.

## Exact fault attribution

`ExternalFaultController.configure` returns a controller-issued rule handle.
For HTTP it contains the rule ID, target, request method, request path, phase,
and action. The driver derives the exact delivery route from the payment request
and configures the gateway with that method/path match.

Gateway evidence exposes the non-secret method/path match together with rule ID,
phase, action, remaining count, and applied count. Delivery identifiers and
request bodies remain redacted. A configured fault counts as exercised only
when the exact stored handle appears in gateway evidence with matching route,
phase, action, and `applied > 0`. Traffic or application of any unrelated rule
cannot satisfy the scenario.

## Suite binding

The suite loader computes:

```text
sha256(
  "cashu-fault-lab/release-suite-bundle-v1\0" ||
  length-prefixed raw suite JSON ||
  for each declared scenario in order:
    length-prefixed repository-relative scenario path ||
    length-prefixed raw scenario JSON
)
```

The digest is formatted as `sha256:<64 lowercase hexadecimal characters>`.
Exact file bytes are intentionally bound: changing scenario commands, required
invariants, ordering, or formatting produces a different reviewed artifact.

Release policy schema version 3 requires `releaseSuiteDigest`. The loaded digest
is attached to each matrix result produced in release-suite mode. The policy
rejects a pair with `RELEASE_SUITE_DIGEST_MISMATCH` unless the result digest
equals the policy digest. The CLI also rejects a mismatched suite before adapter
startup so an arbitrary `--release-suite` cannot substitute easier scenarios.

## Conservative suite aggregation

The external smoke run remains a setup and interoperability prerequisite, but
its invariant list is not release evidence when a release suite is selected.

For every invariant required by one or more suite entries:

- all requiring scenarios must contain the invariant;
- every occurrence must pass;
- aggregate confidence is the weakest confidence (`adapter_claimed`, then
  `derived`, then `observed`);
- evidence references are combined and de-duplicated deterministically;
- any failure, non-observable result, or not-applicable result remains
  non-passing.

The aggregate replaces the smoke invariants on the matrix result. Per-scenario
evidence remains attached for diagnostics and is independently checked by the
policy. This prevents stale smoke results from causing false failures or hiding
suite failures.

## Release workflow and materials

The project remains an experimental developer preview:

- tag pushes do not run a workflow that is guaranteed to fail without external
  authorities;
- CI contains a positive gate-engine fixture proving trusted evidence can pass;
- the real repository policy is exercised as an intentionally blocked
  certification check until external adapters, authorities, and provenance are
  supplied;
- no Git tag or GitHub release is created by this branch.

All repository component versions reported by the packaged runtime become
`0.1.0`. The deterministic JSON and HTML demos are regenerated, and metadata
tests reject `0.0.0`. The coverage table will state that all ten named cashu-ts
crash boundaries are exercised while independent implementations remain the
release gap.

## Error handling and DX

Strict qualification fails with stable, actionable messages for:

- missing independent ledger or mint authorities;
- suite digest mismatch;
- missing or rejected aggregate invariants;
- missing exact fault-rule evidence.

Ordinary `matrix --adapters` runs remain usable without evidence authorities.
The adapter guide includes a complete schema-v2 manifest example and explains
which settings are developer-only versus release-qualifying.

## Verification

Every behavioral change uses red-green-refactor. Final verification includes:

1. focused unit tests for oracle confidence, manifest parsing, exact gateway
   evidence, suite loading, aggregation, and release policy;
2. forced typecheck and build for all workspace packages;
3. the complete Docker-free unit suite;
4. PostgreSQL integration and funded Docker lanes when Docker is available;
5. consumer, generated-code, OpenAPI, documentation, formatting, audit, and Rust
   checks;
6. a positive trusted release-gate fixture;
7. the real bundled certification command, which must fail with documented
   external-evidence blockers rather than accidentally pass.

