# Contributing to Cashu Fault Lab

## Local setup

Fork `GautamBytes/cashu-fault-lab` on GitHub, then clone your fork:

```bash
git clone https://github.com/YOUR-USERNAME/cashu-fault-lab.git
cd cashu-fault-lab
git remote add upstream https://github.com/GautamBytes/cashu-fault-lab.git
corepack enable
pnpm install --frozen-lockfile
```

The repository requires Node.js 24 and pnpm 11.15.0. Docker is optional for the default test suite
and required for integration and funded lanes.

Verify the local checkout:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Run the documentation website locally:

```bash
pnpm website:dev
```

Open `http://localhost:3000`. Website-specific checks are available through
`pnpm website:test`, `pnpm website:build`, and `pnpm website:test:e2e`.

## Development workflow

1. Sync your checkout: `git fetch upstream && git switch main && git merge --ff-only upstream/main`
2. Create a focused branch: `git switch -c feat/your-feature`
3. Make your changes, following existing code conventions.
4. Run the checks relevant to your change.
5. Commit with a descriptive conventional commit message.
6. Push your branch: `git push -u origin feat/your-feature`
7. Open a pull request from your fork to `GautamBytes/cashu-fault-lab:main`.

## Pull request checklist

- Explain the problem and the behavior changed.
- Include the commands used to verify the change.
- Add or update tests for changed behavior.
- Keep generated files and documentation synchronized.
- Do not commit secrets, funded credentials, local artifacts, or environment files.
- Keep the pull request focused; separate unrelated refactors.

## Code conventions

- **TypeScript strict mode** — `strict: true`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- **Formatting** — Prettier (`pnpm format:check`). No manual formatting needed.
- **Imports** — Use `.js` extensions for Node-targeted ESM imports. The Next.js website uses bundler-resolved extensionless imports. Import types with `type` keyword.
- **No unused imports** — `verbatimModuleSyntax` enforces this.
- **No sensitive data in tests** — Use fake tokens only. Secrets are redacted in artifacts.

## Adding a scenario

1. Create a `.json` file under `scenarios/<category>/`. See existing files for the schema.
2. Include `name` and `description` fields.
3. Command types: `configure_fault`, `arm_crash`, `send`, `start_send`, `restart`,
   `advance_time`, `clear_faults`, `assert_quiescent`.
4. Add a handler in `apps/lab-cli/src/packaged-runtime.ts` if using a new scenario name.

## Adding an adapter

1. Generate a standalone scaffold:
   `npx cashu-fault-lab@0.2.0 adapter init --language typescript --name your-wallet`.
   Choose `typescript`, `rust`, or `python`.
2. Implement the 8 HTTP routes described in `docs/adapter-guide.md`, including cumulative
   redemption-start evidence from `GET /v1/redemptions`.
3. Start the adapter on a loopback origin and export the bearer-token environment variable named by
   its generated `adapter-manifest.json`.
4. Run the read-only contract check:
   `npx cashu-fault-lab@0.2.0 adapter preflight --adapters ./your-wallet/adapter-manifest.json`.
5. Run the response-loss and duplicate-delivery preview:
   `npx cashu-fault-lab@0.2.0 adapter preview --adapters ./your-wallet/adapter-manifest.json --sender your-wallet --receiver your-wallet`.
6. Share the redacted feedback bundle from `cashu-fault-results/` when requesting review.

## Tests

- `pnpm test` and `pnpm test:unit` run the Docker-free default suite.
- `pnpm test:integration` runs PostgreSQL/Testcontainers suites and prints an explicit
  skipped-tier reason when Docker is unavailable.
- `pnpm test:funded` runs strict real-mint, funded-wallet, restart, and relay lanes;
  missing prerequisites fail the command.
- `pnpm test:all` runs unit, integration, and funded tiers in order.
- `pnpm lab doctor` prints tier readiness and the exact runnable commands.
- Rust tests: `cargo test --manifest-path adapters/cdk/Cargo.toml`.

## Commit messages

Follow conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`.

## Reporting issues

Open an issue on GitHub with:

- The scenario, seed, and command that failed
- The artifact file (`artifacts/latest.json`) if available
- Your environment (Node version, OS)
