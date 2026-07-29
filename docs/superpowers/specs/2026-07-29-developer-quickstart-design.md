# Developer Quickstart Design

## Goal

Make the experimental v0.1 developer preview runnable with one command after cloning, or with no
local toolchain setup through GitHub Codespaces. Keep execution local to the developer's machine or
Codespace so wallets, test tokens, and adapter credentials are not sent to a hosted Cashu Fault Lab
service.

## Selected approach

Ship two entry paths backed by the same repository workflow:

1. A pinned GitHub Codespaces development container with Node.js 24, pnpm 11.15.0, and an isolated
   Docker daemon.
2. A repository-root `./scripts/quickstart` command for developers who already have Node.js 24 and
   Docker.

The website uses Codespaces as its primary trial action and keeps the local quickstart visible as a
copyable command. The canonical instructions remain in `README.md`, which the website already
renders as its Getting Started documentation.

## Architecture

### Dev container

`.devcontainer/devcontainer.json` uses a pinned Node.js 24 Bookworm development image and a pinned
Docker-in-Docker feature. Its post-create command activates the repository's pnpm version through
Corepack and installs the frozen lockfile. Docker stays inside the Codespace; the configuration does
not mount a developer's host Docker socket.

### Quickstart command

`scripts/quickstart.mjs` owns validation and orchestration. It:

- rejects unsupported Node.js versions;
- checks that Docker CLI and the daemon are available;
- installs the frozen workspace unless `--skip-install` is selected;
- builds the monorepo;
- runs the deterministic response-loss demo with a fixed quickstart seed;
- writes secret-redacted JSON and HTML outputs under `artifacts/`; and
- relies on the existing demo lifecycle to stop services it started.

`scripts/quickstart` is a small executable shell entrypoint that invokes the module. `--check`
performs prerequisite validation without installing, building, or starting containers.

The orchestration module accepts a command runner so tests can verify the real command sequence
without replacing global process APIs.

### Website and documentation

The homepage primary action opens a new Codespace for `GautamBytes/cashu-fault-lab`. The hero command
shows `./scripts/quickstart`, and the secondary action still links to GitHub. The README begins with
the same Codespaces and local paths, explicitly labels the project as an experimental preview, and
preserves the certification boundary.

## Failure handling

- Unsupported Node.js, missing Docker, or an unavailable Docker daemon fails before install/build.
- Failed install, build, or demo commands preserve their exit status and stop the quickstart.
- The script prints the exact remediation or failed command without printing environment variables,
  adapter tokens, proof material, or request bodies.
- The quickstart never weakens the strict release policy and does not represent its demo as
  certification.

## Testing

- Node unit tests cover argument parsing, Node version validation, preflight failure, check-only
  mode, and the full install/build/demo command order.
- Repository contract tests parse the dev-container JSON and assert pinned runtime, Docker feature,
  Corepack setup, README commands, and homepage Codespaces link.
- Website component and Playwright tests exercise the new primary action at desktop and mobile
  viewports.
- A real end-to-end smoke run executes `./scripts/quickstart --skip-install` against Docker and
  validates the generated JSON and HTML artifacts.
- The final gate includes formatting, type checking, unit tests, build, website E2E, dev-container
  configuration validation, and `git diff --check`.

## Non-goals

- Publishing an npm package before repository-relative runtime assets are bundled.
- Hosting wallet execution or Cashu bearer-token tests on Vercel.
- Claiming Cashu certification or removing external integration blockers.
- Automatically publishing a GitHub release or mutating `main`.
