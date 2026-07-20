# Contributing to Cashu Fault Lab

## Getting started

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

## Development workflow

1. Create a feature branch from `main`: `git checkout -b feat/your-feature`
2. Make your changes, following existing code conventions
3. Run checks: `pnpm format:check && pnpm typecheck && pnpm test`
4. Commit with a descriptive message
5. Push and open a PR against `main`

## Code conventions

- **TypeScript strict mode** — `strict: true`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- **Formatting** — Prettier (`pnpm format:check`). No manual formatting needed.
- **Imports** — Use `.js` extensions for ESM imports. Import types with `type` keyword.
- **No unused imports** — `verbatimModuleSyntax` enforces this.
- **No sensitive data in tests** — Use fake tokens only. Secrets are redacted in artifacts.

## Adding a scenario

1. Create a `.json` file under `scenarios/<category>/`. See existing files for the schema.
2. Include `name` and `description` fields.
3. Command types: `configure_fault`, `send`, `restart`, `advance_time`, `clear_faults`, `assert_quiescent`.
4. Add a handler in `apps/lab-cli/src/packaged-runtime.ts` if using a new scenario name.

## Adding an adapter

1. Copy `adapters/template/` to `adapters/your-wallet/`.
2. Implement the 7 HTTP routes described in `docs/adapter-guide.md`.
3. Register in a manifest file and run `pnpm lab matrix --adapters manifest.json`.
4. See `adapters/template/README.md` for the checklist.

## Tests

- `pnpm test` runs all unit and integration tests.
- Docker-dependent tests are skipped when Docker is unavailable.
- Rust tests: `cargo test --manifest-path adapters/cdk/Cargo.toml`.

## Commit messages

Follow conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`.

## Reporting issues

Open an issue on GitHub with:

- The scenario, seed, and command that failed
- The artifact file (`artifacts/latest.json`) if available
- Your environment (Node version, OS)
