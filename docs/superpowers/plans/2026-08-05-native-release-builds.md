# Native Release Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the emulated multi-architecture release build with native, free GitHub-hosted builds while preserving immutable tags and every publication gate.

**Architecture:** A preflight job classifies existing version tags, a static image-by-platform matrix builds only missing images on native amd64/arm64 runners and uploads canonical digests, and one merge job per image creates and verifies the final manifest. The CDK Docker target uses a pinned `cargo-chef` dependency layer so ordinary source changes do not rebuild the entire Rust dependency graph.

**Tech Stack:** GitHub Actions, Docker Buildx, GHCR registry cache, Bash, Node.js test runner, Docker multi-stage builds, Rust 1.97, cargo-chef 0.1.77.

## Global Constraints

- Use standard GitHub-hosted runners only; do not add a paid service or self-hosted runner.
- Preserve `linux/amd64` and `linux/arm64` for all three public runtime images.
- Preserve version and commit-SHA image tags, cross-commit overwrite refusal, anonymous-pull verification, npm provenance, and GitHub Release behavior.
- Do not claim a measured speedup before a tagged release runs the new workflow.
- Use red-green-refactor for each behavior change and commit only after the focused test passes.

---

### Task 1: Specify the native release topology in tests

**Files:**

- Modify: `scripts/npm-package.test.mjs`

- [ ] Add a test that reads `.github/workflows/publish.yml` and requires `ubuntu-24.04` for amd64 plus `ubuntu-24.04-arm` for arm64.
- [ ] Require an explicit single `platform` per matrix row and reject `docker/setup-qemu-action`.
- [ ] Require digest-mode pushes, digest artifacts, `docker buildx imagetools create`, and a post-merge check for both `linux/amd64` and `linux/arm64`.
- [ ] Require stable registry caches isolated by image and architecture.
- [ ] Require a preflight revision guard and ensure `npm` depends on final manifests rather than raw platform builds.
- [ ] Run `node --test scripts/npm-package.test.mjs` and confirm the new test fails against the old workflow for the expected missing native-build contract.
- [ ] Commit the failing contract test as `test(ci): specify native release build topology`.

### Task 2: Implement native image builds and manifest assembly

**Files:**

- Modify: `.github/workflows/publish.yml`

- [ ] Add `runtime-preflight` to check every version tag once, reuse only same-revision tags, reject conflicting revisions, and output the missing-image JSON list.
- [ ] Replace `runtime-images` with a six-row `runtime-platforms` matrix containing image, target, platform, architecture, and native runner.
- [ ] Gate build steps with the preflight missing-image list; use no QEMU setup.
- [ ] Push each platform by digest and export an image-and-architecture-specific one-day artifact.
- [ ] Use stable GHCR registry cache references scoped by image and architecture.
- [ ] Add `runtime-manifests` with one row per image; download exactly two digest artifacts and publish the version and SHA tags with `docker buildx imagetools create`.
- [ ] Inspect the raw final manifest and require the unique Linux platform set to equal `linux/amd64` plus `linux/arm64`.
- [ ] Make npm depend on `runtime-manifests`, retaining the existing anonymous-pull and installed-package gates.
- [ ] Run `node --test scripts/npm-package.test.mjs` and confirm the release contract passes.
- [ ] Run Prettier against the workflow and test, then commit as `perf(ci): build release images on native runners`.

### Task 3: Specify the CDK dependency cache boundary

**Files:**

- Modify: `scripts/npm-package.test.mjs`

- [ ] Add a Dockerfile contract test requiring cargo-chef version `0.1.77`, a planner recipe, and a cook layer.
- [ ] Assert that dependency cooking occurs before the real CDK source and OpenAPI input are copied into the build stage.
- [ ] Assert the final CDK runtime stage and release binary path remain unchanged.
- [ ] Run `node --test scripts/npm-package.test.mjs` and confirm the new test fails for the expected missing cargo-chef boundary.
- [ ] Commit the failing test as `test(docker): specify CDK dependency cache boundary`.

### Task 4: Cache the locked Rust dependency graph

**Files:**

- Modify: `infra/docker/wallet-adapters.Dockerfile`

- [ ] Add a Rust chef base stage and install `cargo-chef` pinned to `0.1.77` with `--locked`.
- [ ] Add a planner stage rooted at `adapters/cdk` that sees the generated Rust path dependency and emits `recipe.json`.
- [ ] Make the CDK build stage cook the locked release dependency graph before copying real adapter source, generated contract source, and OpenAPI input.
- [ ] Keep the final binary build command, runtime base, unprivileged user, and entrypoint behavior unchanged.
- [ ] Run `node --test scripts/npm-package.test.mjs` and confirm all release asset contracts pass.
- [ ] Run `docker build --target cdk-adapter --platform linux/arm64 -f infra/docker/wallet-adapters.Dockerfile .` on the local native arm64 Docker engine; fix any recipe/path issue before proceeding.
- [ ] Commit as `perf(docker): cache CDK Rust dependencies`.

### Task 5: Verify the complete change

**Files:**

- Verify only unless a check exposes a scoped defect.

- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm test`.
- [ ] Run `git diff --check` and inspect the branch diff from `origin/main` for accidental release-policy weakening.
- [ ] Validate that workflow image names, targets, runner/platform pairs, cache tags, artifact names, and downstream dependencies are internally consistent.
- [ ] Record that production timing remains unmeasured until the next release tag.

### Task 6: Publish the pull request

**Files:**

- No additional source changes expected.

- [ ] Push `codex/optimize-release-builds` to origin.
- [ ] Open a ready pull request describing the bottleneck, native fan-out, digest merge, cache strategy, cargo-chef boundary, preserved safety gates, and verification evidence.
- [ ] State clearly that the speedup is expected rather than measured until the next tagged publish.
- [ ] Watch the initial PR checks, investigate any failure, and update the branch before reporting completion.
