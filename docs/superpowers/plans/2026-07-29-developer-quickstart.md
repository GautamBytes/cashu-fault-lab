# Developer Quickstart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a tested one-command local demo and a zero-local-toolchain GitHub Codespaces path
for Cashu Fault Lab's experimental v0.1 developer preview.

**Architecture:** A dependency-injected Node.js quickstart orchestrator validates Node and Docker,
then runs the frozen install, build, and deterministic demo. A thin executable shell wrapper exposes
it from the repository root workflow. A pinned dev container supplies Node, Corepack, pnpm, and an
isolated Docker daemon; the README and website point to the same workflow.

**Tech Stack:** Node.js 24, Node test runner, pnpm 11.15.0, Docker Compose, Development Containers,
Next.js 16, Vitest, Playwright.

## Global Constraints

- The project remains an experimental v0.1 developer preview, not certification.
- The strict release policy and external-integration blockers must remain unchanged.
- The quickstart must not print environment variables, tokens, proof material, or request bodies.
- Codespaces must use an isolated Docker daemon rather than the developer's host socket.
- Canonical setup documentation remains in `README.md`; the website renders that file.
- Production code follows TDD: add each behavior test, observe its expected failure, then implement.

---

### Task 1: Quickstart orchestration

**Files:**

- Create: `scripts/quickstart.mjs`
- Create: `scripts/quickstart`
- Create: `scripts/quickstart.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces:
  - `parseQuickstartArgs(argv: readonly string[]): { checkOnly: boolean; skipInstall: boolean }`
  - `assertSupportedNodeVersion(version: string): void`
  - `runQuickstart(options): Promise<void>`
  - executable `./scripts/quickstart [--check] [--skip-install]`

- [ ] **Step 1: Write failing argument and Node-version tests**

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertSupportedNodeVersion, parseQuickstartArgs, runQuickstart } from './quickstart.mjs';

describe('developer quickstart', () => {
  it('parses check and skip-install modes', () => {
    assert.deepEqual(parseQuickstartArgs(['--check', '--skip-install']), {
      checkOnly: true,
      skipInstall: true,
    });
    assert.throws(() => parseQuickstartArgs(['--unknown']), /Unknown quickstart option/);
  });

  it('requires Node.js 24', () => {
    assert.doesNotThrow(() => assertSupportedNodeVersion('v24.14.1'));
    assert.throws(() => assertSupportedNodeVersion('v22.18.0'), /Node.js 24 is required/);
  });
});
```

- [ ] **Step 2: Run the unit test and verify RED**

Run:

```bash
node --test scripts/quickstart.test.mjs
```

Expected: FAIL because `scripts/quickstart.mjs` does not exist.

- [ ] **Step 3: Implement parsing and Node validation**

Create `scripts/quickstart.mjs` with the exported functions. Unknown options must throw
`Unknown quickstart option: <option>`. Versions outside major 24 must throw
`Node.js 24 is required; found <version>`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `node --test scripts/quickstart.test.mjs`.

Expected: 2 passing tests.

- [ ] **Step 5: Add failing orchestration tests**

Add injected-runner tests that assert:

```js
const commands = [];
await runQuickstart({
  checkOnly: false,
  skipInstall: false,
  nodeVersion: 'v24.14.1',
  repositoryRoot: '/repo',
  stdout: () => {},
  runCommand: async (file, args, options) => {
    commands.push([file, args, options]);
  },
});

assert.deepEqual(
  commands.map(([file, args]) => [file, args]),
  [
    ['docker', ['--version']],
    ['docker', ['info', '--format', '{{.ServerVersion}}']],
    ['corepack', ['pnpm', 'install', '--frozen-lockfile']],
    ['corepack', ['pnpm', 'build']],
    [
      'corepack',
      [
        'pnpm',
        'lab',
        'demo',
        '--seed',
        'cashu-fault-lab-v0.1.0-quickstart',
        '--artifact',
        'artifacts/quickstart.json',
        '--report',
        'artifacts/quickstart.html',
      ],
    ],
  ],
);
```

Also assert `--check` stops after the two Docker probes, `--skip-install` omits only install, and a
failed Docker probe becomes a remediation-focused error.

- [ ] **Step 6: Run orchestration tests and verify RED**

Run `node --test scripts/quickstart.test.mjs`.

Expected: FAIL because `runQuickstart` does not yet orchestrate commands.

- [ ] **Step 7: Implement the minimal orchestrator and executable wrapper**

Use `node:child_process` `spawn` with argument arrays and `shell: false`. Normal install/build/demo
commands inherit stdio; preflight probes stay quiet. On non-zero exit, throw a sanitized message
containing only the executable, arguments, and exit code.

Create `scripts/quickstart`:

```sh
#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/quickstart.mjs" "$@"
```

Mark it executable and add `quickstart: "./scripts/quickstart"` to root scripts. Add
`scripts/quickstart.test.mjs` to the root `test:unit` Node test list.

- [ ] **Step 8: Run focused and root tests and verify GREEN**

Run:

```bash
node --test scripts/quickstart.test.mjs
pnpm test
```

Expected: all quickstart tests and every root unit test task pass.

- [ ] **Step 9: Commit**

```bash
git add package.json scripts/quickstart scripts/quickstart.mjs scripts/quickstart.test.mjs
git commit -m "feat: add one-command developer quickstart"
```

### Task 2: Pinned Codespaces environment

**Files:**

- Create: `.devcontainer/devcontainer.json`
- Create: `scripts/developer-environment.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: `./scripts/quickstart`
- Produces: a Development Containers configuration usable by GitHub Codespaces and the devcontainer
  CLI.

- [ ] **Step 1: Write a failing dev-container contract test**

Parse `.devcontainer/devcontainer.json` and assert:

```js
assert.equal(config.image, 'mcr.microsoft.com/devcontainers/typescript-node:5.0.1-24-bookworm');
assert.deepEqual(config.features, {
  'ghcr.io/devcontainers/features/docker-in-docker:3.0.1': {},
});
assert.match(config.postCreateCommand, /corepack enable/);
assert.match(config.postCreateCommand, /pnpm install --frozen-lockfile/);
assert.deepEqual(config.forwardPorts, [3000]);
```

Add the test file to `test:unit`.

- [ ] **Step 2: Run and verify RED**

Run `node --test scripts/developer-environment.test.mjs`.

Expected: FAIL because `.devcontainer/devcontainer.json` does not exist.

- [ ] **Step 3: Add the pinned dev-container configuration**

Create:

```json
{
  "name": "Cashu Fault Lab",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:5.0.1-24-bookworm",
  "features": {
    "ghcr.io/devcontainers/features/docker-in-docker:3.0.1": {}
  },
  "postCreateCommand": "corepack enable && corepack pnpm install --frozen-lockfile",
  "forwardPorts": [3000],
  "portsAttributes": {
    "3000": {
      "label": "Cashu Fault Lab website",
      "onAutoForward": "notify"
    }
  },
  "remoteUser": "node"
}
```

- [ ] **Step 4: Run contract and devcontainer CLI validation**

Run:

```bash
node --test scripts/developer-environment.test.mjs
npx --yes @devcontainers/cli@0.88.0 read-configuration --workspace-folder .
```

Expected: contract tests pass and the CLI returns a resolved configuration with exit code 0.

- [ ] **Step 5: Commit**

```bash
git add .devcontainer/devcontainer.json package.json scripts/developer-environment.test.mjs
git commit -m "feat: add Codespaces developer environment"
```

### Task 3: Documentation and website entry points

**Files:**

- Modify: `README.md`
- Modify: `apps/website/app/page.tsx`
- Modify: `apps/website/components/home/home.test.tsx`
- Modify: `apps/website/e2e/portal.spec.ts`
- Modify: `scripts/developer-environment.test.mjs`

**Interfaces:**

- Consumes: the Codespaces URL and `./scripts/quickstart`.
- Produces: matching website and repository onboarding.

- [ ] **Step 1: Add failing homepage and documentation assertions**

The homepage unit test must require:

```ts
expect(within(hero).getByRole('link', { name: 'Open in Codespaces' })).toHaveAttribute(
  'href',
  'https://codespaces.new/GautamBytes/cashu-fault-lab?quickstart=1',
);
expect(within(hero).getByText('./scripts/quickstart')).toBeVisible();
```

The repository contract test must require the same Codespaces URL, `./scripts/quickstart`, and
`./scripts/quickstart --check` in `README.md`.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
pnpm --filter @cashu-fault-lab/website exec vitest run components/home/home.test.tsx
node --test scripts/developer-environment.test.mjs
```

Expected: FAIL because the current hero and README do not expose the new entry paths.

- [ ] **Step 3: Update canonical onboarding and the homepage**

Add a `Quickstart` section before the requirements:

````markdown
## Quickstart

[Open Cashu Fault Lab in GitHub Codespaces](https://codespaces.new/GautamBytes/cashu-fault-lab?quickstart=1)
to use the pinned Node.js, pnpm, and isolated Docker environment without configuring them locally.
Then run:

```bash
./scripts/quickstart
```
````

For a local clone, install Node.js 24 and Docker, then run the same command. Use
`./scripts/quickstart --check` for a non-mutating prerequisite check.

````

Change the homepage primary action to `Open in Codespaces`, open it in a new tab with
`rel="noreferrer noopener"`, and render `./scripts/quickstart` in the hero command block. Keep the
GitHub link secondary.

- [ ] **Step 4: Update Playwright expectations**

Replace homepage expectations for `Run the deterministic demo` with `Open in Codespaces`, checking
the exact URL and ensuring the link is visible and keyboard-focusable at desktop, tablet, and mobile
viewports.

- [ ] **Step 5: Run focused website tests and verify GREEN**

Run:

```bash
pnpm --filter @cashu-fault-lab/website exec vitest run components/home/home.test.tsx
node --test scripts/developer-environment.test.mjs
pnpm website:test
````

Expected: all focused and website unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add README.md apps/website/app/page.tsx apps/website/components/home/home.test.tsx \
  apps/website/e2e/portal.spec.ts scripts/developer-environment.test.mjs
git commit -m "docs: expose zero-setup developer quickstart"
```

### Task 4: End-to-end verification

**Files:**

- Runtime outputs only: `artifacts/quickstart.json`, `artifacts/quickstart.html` (ignored)

- [ ] **Step 1: Run the real local quickstart**

Run:

```bash
./scripts/quickstart --skip-install
```

Expected: Docker preflight, build, and deterministic demo succeed; the demo reports a passed
response-loss run and cleans up services it started.

- [ ] **Step 2: Validate quickstart artifacts**

Run:

```bash
node -e "const a=require('./artifacts/quickstart.json'); if(a.status!=='passed')process.exit(1)"
test -s artifacts/quickstart.html
```

Expected: exit code 0 and a non-empty HTML report.

- [ ] **Step 3: Run the website browser E2E suite**

Run:

```bash
pnpm website:test:e2e
```

Expected: every public route, accessibility scan, responsive viewport, mobile navigation, search,
and homepage Codespaces CTA test passes.

- [ ] **Step 4: Build and execute the dev container**

Run:

```bash
npx --yes @devcontainers/cli@0.88.0 up --workspace-folder .
npx --yes @devcontainers/cli@0.88.0 exec --workspace-folder . ./scripts/quickstart --skip-install
```

Expected: the pinned development container starts and the same deterministic demo passes using its
Docker-in-Docker daemon.

- [ ] **Step 5: Run the full final gate**

Run:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:consumer
pnpm website:test:e2e
git diff --check
```

Expected: every command exits 0. Docker-backed integration tests run when Docker is available.

- [ ] **Step 6: Commit any verification-only corrections**

If verification required changes, add only the relevant files and commit:

```bash
git commit -m "fix: harden developer quickstart verification"
```
