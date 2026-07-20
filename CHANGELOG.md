# Changelog

All notable changes to Cashu Fault Lab will be documented in this file.

## Unreleased

### Added

- `lab ls` command to discover available scenarios
- `lab inspect` command to pretty-print scenario files
- `lab gen-id` command to generate ProtocolId values
- `--verbose` flag on `run`, `replay`, and `matrix` commands
- Elapsed time displayed on all command results
- OpenAPI 3.1 specification for the adapter contract (`spec/openapi.yaml`)
- `.env.example` for local development setup
- MIT LICENSE file
- `CODE_OF_CONDUCT.md` and `CONTRIBUTING.md`
- Package-level READMEs for all 13 packages and apps

### Changed

- Adapter template replaced with a scaffolded Fastify server (7 route stubs, tests, Dockerfile)
- `DirectExternalFaultController.configure()` is now a no-op instead of throwing
- `ExternalAdapterScenarioDriver.restart()` gracefully degrades when restart is unavailable

### Fixed

- Oracle invariants: added net amount consistency validation (settled amount must match credit)
- Removed dead transport convergence loop in oracle invariants
