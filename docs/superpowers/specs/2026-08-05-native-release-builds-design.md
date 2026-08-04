# Native Multi-Architecture Release Builds

## Problem

Cashu Fault Lab publishes three `linux/amd64` and `linux/arm64` runtime images before publishing its npm package. The v0.1.3 and v0.1.4 release runs spent 66–74 minutes building the CDK adapter because both architectures were built on one x64 runner and the Rust-heavy arm64 build ran through QEMU. The v0.2.0 workflow showed the same bottleneck.

Release duration must not be reduced by dropping arm64, weakening image immutability, reusing binaries built from another commit, or publishing npm before the public images are verified.

## Constraints

- Use only standard GitHub-hosted runners that are free for this public repository.
- Continue publishing `linux/amd64` and `linux/arm64` variants for every runtime image.
- Preserve version tags and commit-SHA tags.
- Preserve the existing refusal to overwrite a version tag owned by another commit.
- Keep npm publication gated on anonymous pulls of all final runtime manifests and the installed public-runtime Docker demo.
- Do not claim a measured speedup until a later tagged release supplies timing evidence.

## Chosen Design

### Native build fan-out

Replace the image-level matrix that runs both platforms under QEMU with an image-by-platform matrix:

- `linux/amd64` runs on `ubuntu-24.04`.
- `linux/arm64` runs on `ubuntu-24.04-arm`.

Both labels are standard GitHub-hosted runners for public repositories. The arm64 label remains a public-preview dependency, so the workflow will pin the explicit Ubuntu version rather than a moving `latest` alias.

Each job builds one target for one native platform and pushes it to GHCR by canonical digest. No version tag is exposed until both platform builds for that image succeed.

### Manifest assembly

Each platform job writes its resulting digest to a narrowly named artifact. A merge job downloads the two digest artifacts for one image and runs `docker buildx imagetools create` to publish:

- `ghcr.io/gautambytes/<image>:<version>`
- `ghcr.io/gautambytes/<image>:sha-<short-commit>`

The merge job then inspects the final version tag and requires exactly the requested `linux/amd64` and `linux/arm64` variants before allowing npm publication.

### Immutable reruns

A preflight job checks each final version tag before any build:

- A missing version tag is eligible for a build.
- An existing tag whose image revision equals the tagged Git commit is safe to reuse during a workflow rerun.
- An existing tag owned by any other revision fails immediately.

The preflight output controls which image/platform rows build and which image rows need manifest assembly. This retains recoverability for partial or repeated workflow runs without permitting mutable release tags.

### Cache isolation

Build caches are exported to stable GHCR registry-cache tags scoped by image target and platform. This avoids GitHub Actions cache visibility boundaries between release tags and prevents parallel architectures or unrelated image targets from overwriting one another's cache entries. GHCR usage remains free for this public project. Cache tags are explicitly mutable build accelerators; release version and commit-SHA tags remain immutable outputs.

### Rust dependency boundary

The CDK Docker build will separate dependency metadata from application source with `cargo-chef` pinned to `0.1.77`. A planner stage prepares a dependency recipe, and a cook stage compiles the locked dependency graph before copying the real adapter source. Changes limited to application source then reuse compiled dependency layers while still recompiling and labeling the application for the current commit.

The final runtime stage and binary path remain unchanged.

## Workflow Boundaries

The optimized release path has four units:

1. `runtime-preflight`: validates tag ownership and emits the missing-image matrix.
2. `runtime-platforms`: builds one image target on one native architecture and records its digest.
3. `runtime-manifests`: assembles and verifies final two-platform manifests.
4. `npm` and `github-release`: retain the current publication and release-note behavior after the manifest gate.

No runtime job receives broader repository permissions than the current workflow. GHCR login continues to use the workflow-scoped `GITHUB_TOKEN`.

## Failure Handling

- Failure of either platform prevents final manifest creation for that image.
- Missing or duplicate digest artifacts fail manifest assembly.
- A final manifest missing either required architecture fails before npm.
- A conflicting existing version tag fails before any image mutation.
- A safe rerun may reuse a final image only when its revision label matches `GITHUB_SHA`.
- npm and GitHub Release remain downstream and cannot run after a failed image stage.

## Test Strategy

Add repository tests that fail before implementation and enforce:

- explicit free native runner labels for amd64 and arm64;
- no QEMU setup in the publish workflow;
- one platform per build row;
- platform-isolated cache scopes;
- digest artifacts and `imagetools create` manifest assembly;
- post-merge inspection for both required architectures;
- preservation of version-tag conflict protection, anonymous pull verification, npm provenance, and GitHub Release creation;
- a cacheable CDK dependency stage that precedes the real source copy.

Verification will include the focused release tests, the full unit suite, formatting, type checking, build, Dockerfile parsing/native CDK image build where available, and GitHub PR CI. Only a future tag can measure the production release-time improvement.

## Alternatives Rejected

### Cache-only QEMU build

This is smaller but leaves the dominant arm64 Rust compilation under emulation whenever cache invalidation occurs.

### Docker reusable distributed builder

Docker's reusable workflow can perform native fan-out automatically, but adopting it would move immutability, partial-rerun, metadata, and manifest policy behind a newer external workflow contract. The project-specific explicit jobs are easier to audit and regression-test.

### Retagging previous release images

This would be fast but would make a new release tag refer to binaries built from an older commit. That conflicts with the existing revision guard and weakens provenance.

## Success Criteria

- The pull request is green without weakening any current release gate.
- The publish workflow contains no QEMU step.
- Both architectures build on native standard GitHub runners and merge into the same public tags as before.
- npm remains blocked until all three final manifests are public and two-platform complete.
- The next tagged release records the first valid before/after timing comparison.

## References

- [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Docker multi-platform builds with GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [Docker build cache optimization](https://docs.docker.com/build/cache/optimize/)
- [`docker buildx imagetools create`](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/)
