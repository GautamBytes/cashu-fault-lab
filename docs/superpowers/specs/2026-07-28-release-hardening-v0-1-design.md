# Cashu Fault Lab v0.1 Release Hardening Design

## Objective

Prepare Cashu Fault Lab for an honest v0.1 developer-preview release by completing
the six code-controlled targets approved on 2026-07-28:

1. Make generated adapters conform to the real adapter contract.
2. Make external transport-fault evidence route-aware and reliable.
3. Aggregate named fault scenarios in release qualification.
4. Exercise every named process-crash boundary in the funded cashu-ts lane.
5. Improve Docker build context and preserve safe failure diagnostics.
6. Prepare, but do not publish, the v0.1 release materials.

The implementation will live on `codex/release-hardening-v0-1`.

## Non-goals

- Publishing a GitHub release, tag, package, or upstream Cashu discussion.
- Claiming official Cashu certification or an accepted Cashu NUT.
- Treating a project-authored adapter as independent ecosystem validation.
- Upgrading CDK to restart-safe durability without a durable CDK wallet/session
  implementation.
- Relaxing the checked-in release policy to obtain a passing result.

## Architecture

The work is divided into six independently testable vertical slices. Existing
package boundaries remain intact:

- `adapter-contract` remains the source of truth for adapter HTTP validation.
- `scenario-runner` owns fault execution, scenario aggregation, and release
  evidence.
- `lab-cli` owns adapter generation, orchestration, and user-facing commands.
- Bundled cashu-ts sender/receiver components provide the funded restart-safe
  implementation.
- `report` renders the evidence without deciding whether it qualifies.

The release gate will consume scenario evidence rather than inferring release
quality from a successful happy-path matrix case.

## 1. Contract-correct adapter generation

### Generated models

Generated TypeScript, Rust, and Python projects must use the canonical receipt
wire vocabulary:

- Status is `processing`, `settled`, or `rejected`.
- `detail_code` is required and non-empty.
- Field names match the adapter OpenAPI and JSON schemas.

Generated capability documents must contain valid development identities. The
scaffolder will derive deterministic, non-placeholder digests from the template
language, project name, role, and current contract digest. These identities remain
development identities and therefore do not become release-eligible provenance.

### Conformance verification

Repository tests will generate all three templates and validate their capability
documents with `validateAdapterResponse`.

The generated-template CI lane will additionally:

1. Build and test each generated project.
2. Start its HTTP server on loopback with a test token.
3. Connect using the real `HttpAdapterClient`.
4. Validate capability discovery and reset.
5. Verify unsupported operations use the canonical authenticated `501 N/A`
   response.

This catches drift between standalone templates and the lab client.

## 2. Route-aware fault evidence

`ExternalFaultEvidence` will distinguish controller-observed traffic from
runner-observed send attempts.

The external scenario driver will apply these rules:

- A successful direct delivery records the sender control attempt as runner
  evidence even when an unrelated configured gateway observed zero requests.
- Gateway counters supplement runner evidence when the payment target traverses
  that gateway.
- If a scenario configured an injectable transport fault, at least one matching
  controller-observed request must exist. Otherwise the scenario fails with an
  explicit `fault was not exercised` diagnostic.
- Zero gateway counters are valid when no gateway fault was configured and the
  selected payment route bypassed that gateway.

The controller will expose enough route metadata for the driver to determine
whether it can observe the selected payment endpoint. It will never silently
claim that a fault was applied to unrelated traffic.

## 3. Release-suite aggregation

### Manifest

A versioned `spec/release-suite.json` and JSON schema will define the named
scenarios required for `delivery-v1` qualification. The initial suite covers:

- response loss and retry convergence;
- duplicate delivery stability;
- external receiver restart after settlement;
- receiver recovery at each named receiver crash boundary;
- sender recovery at each named sender crash boundary.

Each entry declares its required transport, role durability, and invariant IDs.
The manifest contains no adapter-specific exceptions.

### Execution model

When both `--release-policy` and an adapter manifest are supplied, the matrix
runner will execute the release suite for every otherwise executable pair.
Every run receives a deterministic seed derived from the matrix seed, sender ID,
receiver ID, and scenario ID.

`MatrixCaseResult` will retain a list of scenario evidence records. Each record
contains:

- scenario ID and seed;
- pass, fail, or not-applicable status;
- invariant results;
- safe failure information;
- component and adapter provenance already present in scenario artifacts.

The aggregate matrix invariant view is conservative:

- a required invariant passes only when every suite scenario that requires it
  supplies accepted evidence;
- a failure remains a failure;
- missing or not-observable evidence never becomes a pass;
- not-applicable scenarios prevent qualification when the release suite requires
  their capability.

Smoke-test matrix behavior remains available when no release policy is supplied.

### Reporting

JSON, JUnit, text, and HTML matrix reports will identify the exact pair,
scenario, and invariant that blocked qualification.

## 4. Funded process-crash boundaries

### Boundaries

The existing canonical boundary registry remains authoritative:

Sender:

- `sender_before_proof_reservation`
- `sender_after_reservation_before_payload_persistence`
- `sender_after_payload_persistence_before_network_send`
- `sender_after_send_before_response`

Receiver:

- `receiver_before_mint_request`
- `receiver_after_mint_request_before_response`
- `receiver_after_mint_response_before_output_persistence`
- `receiver_after_output_persistence_before_merchant_credit`
- `receiver_after_credit_before_receipt_persistence`
- `receiver_after_receipt_persistence_before_response_or_outbox`

### Durable one-shot crash arming

The funded cashu-ts lane will use a PostgreSQL-backed crash-arm repository keyed
by run ID, component, boundary, and occurrence. Arming a boundary and consuming
the one-shot trigger are authenticated lab-control operations.

When an armed checkpoint is hit:

1. The checkpoint atomically marks the trigger consumed.
2. The adapter process terminates without graceful in-memory cleanup.
3. Docker restarts the adapter.
4. The runner waits for authenticated readiness.
5. The original delivery resumes from durable sender or receiver state.
6. The oracle checks convergence, stable identity, proof exclusivity, and
   exactly one merchant credit.

Persisting the consumed trigger before termination prevents restart loops.

### Control-surface security

Crash controls are unavailable by default. They are registered only when the
explicit funded-test crash-control flag is enabled. They remain protected by the
existing adapter bearer token, accept only enum-listed boundaries and positive
safe occurrences, impose the normal request-body limit, and never return secrets
or stored payment material.

The public production adapter contract does not require crash controls.
Capabilities advertise the optional test extension only in the funded lab.

CDK continues to report `N/A` for restart-safe sender scenarios until its
in-memory wallet/session implementation becomes durable.

## 5. Developer experience and diagnostics

### Docker context

The root `.dockerignore` will exclude `.worktrees/` and `.pnpm-store/`. A
repository test will prevent these high-volume local directories from returning
to the Docker context.

### Safe attempt diagnostics

Sender delivery records and scenario failures will preserve a bounded diagnostic
for each failed attempt:

- stage;
- stable error category/code;
- retryability;
- attempt number;
- transport type.

Diagnostics must not contain authorization headers, raw payload bytes, proofs,
secrets, tokens, database URLs, or arbitrary upstream response bodies. Unknown
errors are reduced to a stable generic category. Existing report redaction
remains defense in depth.

## 6. v0.1 release preparation

The branch will contain:

- package and component version metadata for `0.1.0`;
- `CHANGELOG.md`;
- `docs/releases/v0.1.0.md`;
- an updated architecture and evidence explanation;
- one deterministic demo command;
- checked-in redacted example JSON and HTML reports;
- explicit developer-preview, experimental-profile, and
  not-official-certification language;
- a release checklist that records the intentionally blocked external
  interoperability requirements.

No tag, GitHub release, package publication, or external post is created.

## Error handling

- Contract drift fails generation/conformance CI with the operation and schema
  path.
- A configured but unobserved fault fails the scenario explicitly.
- Crash-control requests fail closed when disabled, unauthorized, malformed, or
  already consumed.
- Release-suite errors retain the pair and scenario identity without leaking
  adapter secrets.
- Unsupported durability is `N/A`; it is never rewritten as a pass.

## Test strategy

Every behavior change follows red-green-refactor:

1. Add the smallest failing unit or integration test.
2. Run it and confirm the expected failure.
3. Implement the minimum behavior.
4. Run the focused test and affected package suite.
5. Refactor only while green.

Final verification uses Node.js 24 and includes:

- formatting and type checking;
- all package tests without Turbo cache;
- generated TypeScript, Rust, and Python adapter conformance;
- PostgreSQL integration tests;
- funded cashu-ts and CDK lanes;
- all ten real process-crash scenarios;
- release-suite positive and fail-closed cases;
- JSON, JUnit, text, and HTML report tests;
- secret-redaction and unauthorized crash-control tests;
- Rust formatting, strict Clippy, and Rust tests;
- full build and consumer tests.

## Success criteria

- A newly generated adapter is accepted by the real lab client.
- The documented CDK-to-cashu-ts restart scenario works with the normal funded
  environment, including a configured gateway that the route does not traverse.
- A configured transport fault cannot pass unless controller evidence proves it
  was exercised.
- Release qualification evaluates every required named scenario for every
  candidate pair.
- Each canonical sender and receiver boundary causes a real one-shot process
  restart and converges safely in the funded cashu-ts lane.
- Artifacts explain failed attempts without exposing secrets.
- Docker no longer includes local worktrees or pnpm stores.
- The repository is internally ready for an experimental v0.1 preview while its
  external certification gate remains honestly blocked.
