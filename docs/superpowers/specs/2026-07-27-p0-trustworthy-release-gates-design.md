# P0 Trustworthy Release Gates Design

## Status

Approved for implementation on `feat/p0-trustworthy-release-gates`.

## Goal

Make Cashu Fault Lab's default tests, adapter capability claims, scenario evidence, and release decisions match what the lab can actually observe and prove.

## Scope

This change delivers five repository-owned outcomes:

1. Remove the current production dependency advisory.
2. Make the default test command safe on machines without Docker and expose explicit unit, integration, funded, and all-test tiers.
3. Replace adapter capability schema v1 with a breaking, role-specific schema v2.
4. Replace the report-only `scenario-conformance` boolean with structured invariant evidence produced by the oracle/runner.
5. Replace release decisions based only on pass count with a declarative, provenance-aware release policy.

External wallet adoption, reference letters, public relay testing, and changes to Cashu NUTs are outside this scope.

## Compatibility decision

Capability and scenario-result schemas move directly to version 2. There is no compatibility decoder for v1 because the repository has no published release or external adapter contract to preserve. Old payloads fail schema validation with an actionable error.

## Test tiers

The root scripts have these meanings:

- `pnpm test` aliases `pnpm test:unit` and never requires Docker, funded wallets, or external services.
- `pnpm test:unit` runs deterministic package tests that need only local processes and loopback sockets.
- `pnpm test:integration` runs PostgreSQL/Testcontainers suites when Docker is usable. If Docker is absent or the daemon is stopped, the command exits successfully after printing an explicit skipped-tier reason.
- `pnpm test:funded` runs real-mint, wallet-adapter, restart, and relay lanes. Missing Docker, tokens, or required endpoints is an error.
- `pnpm test:all` runs unit, integration, and funded tiers in that order.

Container-backed test files are selected explicitly rather than inferred from a caught container startup error. Unit test commands exclude them, integration commands name them, and funded commands name their workflow entry points.

`lab doctor` reports each tier as `runnable`, `skipped`, or `blocked`, includes the exact command, and preserves the existing individual environment and port checks.

## Adapter capability schema v2

The public capability response is:

```ts
type EvidenceTier = 'T0' | 'T1' | 'T2' | 'T3';
type EvidenceSource =
  'adapter' | 'runner' | 'transport' | 'mint' | 'durable_ledger' | 'durable_state';
type DurabilityLevel = 'process' | 'persistent' | 'restart_safe';

interface AdapterImplementationIdentity {
  readonly id: string;
  readonly version: string;
  readonly language: string;
  readonly runtime: string;
  readonly sourceDigest: string;
  readonly buildDigest: string;
}

interface AdapterRoleCapability {
  readonly transports: readonly AdapterTransport[];
  readonly profiles: readonly string[];
  readonly durability: DurabilityLevel;
  readonly evidence: {
    readonly tier: EvidenceTier;
    readonly sources: readonly EvidenceSource[];
  };
}

interface AdapterMintIdentity {
  readonly id: string;
  readonly implementation: string;
  readonly version?: string;
}

interface AdapterCapabilities {
  readonly schemaVersion: 2;
  readonly implementation: AdapterImplementationIdentity;
  readonly roles: {
    readonly sender?: AdapterRoleCapability;
    readonly receiver?: AdapterRoleCapability;
  };
  readonly nuts: readonly number[];
  readonly encodings: readonly AdapterEncoding[];
  readonly mints: readonly AdapterMintIdentity[];
}
```

Digests use lowercase `sha256:<64 hexadecimal characters>`. An adapter with no release build uses a deterministic development digest derived from its repository identity and locked version, never an empty string or generic placeholder. Mint identities describe the configured mint implementation, not only its URL.

Role support is represented by the presence of `roles.sender` or `roles.receiver`; mixed top-level transports, profiles, and evidence tiers are removed. A role may advertise only evidence sources it can expose through the seven-route contract and runner observations.

The TypeScript contract, JSON Schema, OpenAPI examples, Rust CDK structures, reference implementations, adapters, manifest fixtures, and documentation change atomically.

## Invariant evidence model

Invariant IDs are stable lowercase kebab-case identifiers corresponding one-to-one with the 18 numbered invariants in `spec/invariants.md`.

```ts
type InvariantStatus = 'passed' | 'failed' | 'not_applicable' | 'not_observable';
type EvidenceConfidence = 'observed' | 'derived' | 'adapter_claimed';

interface InvariantEvidenceReference {
  readonly source: 'timeline' | 'receipt' | 'ledger' | 'proofs' | 'capabilities';
  readonly index?: number;
  readonly field?: string;
  readonly description: string;
}

interface InvariantResult {
  readonly id: InvariantId;
  readonly status: InvariantStatus;
  readonly confidence: EvidenceConfidence;
  readonly evidence: readonly InvariantEvidenceReference[];
  readonly reason?: string;
}
```

The oracle exports a registry and an evaluator. The registry owns invariant metadata and applicability. The evaluator consumes the final oracle model, ordered scenario history, scenario commands, and adapter capabilities. It returns one result for every registered invariant.

An invariant is:

- `passed` only when the oracle can point to observed or reproducibly derived evidence.
- `failed` when the model or history violates it.
- `not_applicable` when the scenario does not exercise the relevant behavior.
- `not_observable` when the behavior applies but required evidence is unavailable.

`adapter_claimed` confidence records an adapter assertion but never qualifies a release pass. Report generation renders the runner's invariant results without synthesizing or upgrading them.

Scenario artifact schema version 2 requires `invariants`. Replay preserves the recorded results and re-evaluation must reproduce them for deterministic reference lanes.

## Release policy

The repository owns `spec/release-policy.json`, validated by `spec/schemas/release-policy.schema.json`.

The policy contains:

```json
{
  "schemaVersion": 1,
  "profile": "delivery-v1",
  "minimumQualifyingPairs": 2,
  "requireCrossImplementation": true,
  "requireCrossLanguage": true,
  "requireDistinctBuilds": true,
  "minimumDistinctMints": 2,
  "minimumEvidence": {
    "sender": "T1",
    "receiver": "T3"
  },
  "requiredInvariants": [
    "at-most-once-redemption-start",
    "at-most-one-merchant-credit-per-request",
    "at-most-one-merchant-credit-per-delivery",
    "proof-set-exclusivity",
    "delivery-identity-immutability",
    "stable-duplicate-response",
    "crash-recovery",
    "retry-convergence",
    "independent-mint-evidence",
    "independent-ledger-evidence",
    "reproducibility",
    "no-unsupported-pass"
  ],
  "acceptedConfidence": ["observed", "derived"]
}
```

`evaluateReleasePolicy(policy, matrixResults)` returns:

```ts
interface ReleaseGateResult {
  readonly passed: boolean;
  readonly qualifyingPairs: readonly string[];
  readonly reasons: readonly {
    readonly code: string;
    readonly message: string;
    readonly pair?: string;
  }[];
}
```

A qualifying pair must:

- Have a passed matrix result with scenario evidence attached.
- Use different sender and receiver implementation IDs when cross-implementation is required.
- Use different sender and receiver languages when cross-language is required.
- Use non-identical source/build digest pairs when distinct builds are required.
- Meet the role-specific evidence floor.
- Contain a configured real-mint identity.
- Pass every required invariant with an accepted confidence.

The whole gate must additionally meet the minimum qualifying pair count and minimum distinct mint count. Multiple aliases of the same implementation/build/mint combination count once.

`matrix --min-passes` remains a developer convenience. `matrix --release-policy spec/release-policy.json` is the release path, prints every rejection reason, writes the evaluation into JSON/JUnit/HTML matrix reports, and determines the exit code. Release CI uses only `--release-policy`.

## Dependency remediation

Refresh the pnpm lockfile so Fastify resolves `find-my-way` 9.6.1 or newer without widening direct dependency ranges unnecessarily. `pnpm audit --prod` must report zero known production vulnerabilities at verification time.

## Error handling

- Schema v1 capability responses fail with `SCHEMA_REQUIRED` at `/schemaVersion` or `/roles`.
- Invalid or placeholder digests fail contract validation.
- Missing role evidence prevents a matrix pair from being applicable.
- Missing release evidence produces a release rejection reason; it does not throw away the underlying matrix result.
- Docker absence skips only `test:integration`; it never converts funded tests into passes.
- A malformed release policy fails before adapters or scenarios are started.

## Verification

Every behavior change follows red-green-refactor. Final verification runs without Turbo cache:

1. `pnpm audit --prod`
2. `pnpm format:check`
3. `pnpm exec turbo run typecheck --force`
4. `pnpm exec turbo run build --force`
5. `pnpm test:unit`
6. Docker-disabled `pnpm test` and `pnpm test:integration`
7. Docker-enabled `pnpm test:integration`
8. `pnpm test:funded`
9. `pnpm test:consumer`
10. `pnpm test:browser`
11. `cargo fmt --manifest-path adapters/cdk/Cargo.toml --check`
12. `cargo clippy --manifest-path adapters/cdk/Cargo.toml --all-targets -- -D warnings`
13. `cargo test --manifest-path adapters/cdk/Cargo.toml`
14. A positive release-policy fixture.
15. The packaged reference-only matrix, which must fail with structured independence, evidence, pair-count, and mint-count reasons.

The branch is complete only when all runnable verification commands pass and any environment-blocked funded command is corroborated by the corresponding public CI workflow or is reported as blocked without a completion claim.
