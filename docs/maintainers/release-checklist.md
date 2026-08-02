# Wallet lifecycle v1 maintainer checklist

This checklist governs a `wallet-lifecycle-v1` compatibility claim. A passing local developer suite
is not certification and does not replace independent provenance or maintainer review.

## Required local evidence

- [ ] `pnpm test:lifecycle:funded` passes twice from clean volumes for cashu-ts/CDK ×
      Nutshell/mintd across the funded non-melt operations, with one adapter restart preservation
      check per lane.
- [ ] `pnpm test:lifecycle:regtest` proves one real Lightning settlement after committed-response
      loss, duplicate resume, and adapter restart, with NUT-08 change conservation.
- [ ] `pnpm test:all`, `pnpm typecheck`, `pnpm format:check`, `pnpm openapi:validate`,
      `pnpm codegen:check`, Rust fmt/clippy/tests, and `pnpm audit --prod` pass.
- [ ] One intentionally failing lifecycle seed replays from a clean checkout to a byte-identical
      normalized failure artifact (`pnpm verify:lifecycle:replay` in both trees).
- [ ] Artifact canary scanning finds no proof secrets, tokens, quote IDs, invoices, seeds,
      signatures, preimages, private keys, macaroons, or control credentials.
- [ ] Reports record exact wallet, mint, Bitcoin Core, LND, and fault-gateway versions or digests.

## Strict policy requirements

- [ ] Evidence validates against `spec/lifecycle-release-suite.json` and its published schema.
- [ ] Two independent wallet identities in at least two languages qualify.
- [ ] Two independent mint implementations qualify.
- [ ] Source and build digests come from produced artifacts, not development identities.
- [ ] All seven lifecycle operations and all required scenarios uniquely pass.
- [ ] Every required invariant passes; no required result is skipped or `N/A`.
- [ ] Every required invariant uses `observed` or `derived` confidence; `adapter_claimed` evidence
      is diagnostic only.
- [ ] Every scenario has an exact replay digest and a successful secret scan.
- [ ] No participant alias, contradictory provenance, or evidence-only self-assertion is accepted.

## External review blockers

- [ ] Obtain review from cashu-ts, CDK, Nutshell, and mintd maintainers for the exercised API and
      recovery semantics.
- [ ] Reproduce at least one qualifying wallet build outside this repository.
- [ ] Run a native CDK melt lane with an independently operated Lightning settlement authority.
- [ ] Confirm that the experimental lifecycle profile does not conflict with evolving NUT recovery
      behavior before publishing a compatibility claim.
