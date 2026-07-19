# Cashu Fault Lab adapter template

Use this checklist for a new implementation adapter.

## Identity

- [ ] Pick a stable implementation ID and exact version.
- [ ] Declare `creqA` and `creqB` support from executable vectors.
- [ ] Declare sender and receiver roles per profile.
- [ ] Set the highest evidence tier the adapter passes.

## HTTP control API

- [ ] Implement all seven `/v1` routes from `docs/adapter-guide.md`.
- [ ] Bind to loopback by default.
- [ ] Require a bearer control token outside test mode.
- [ ] Validate request and response bodies with `@cashu-fault-lab/adapter-contract`.
- [ ] Return `N/A` with a reason for unsupported funded operations.

## Payment invariants

- [ ] Reserve one proof set before send.
- [ ] Reuse delivery ID and exact inner bytes on retry.
- [ ] Disable HTTP redirects.
- [ ] Treat relay acknowledgement as transport evidence only.
- [ ] Verify receiver receipts before releasing proofs.
- [ ] Produce one settlement plan and merchant credit under duplicate delivery.

## Tests

- [ ] Parse `spec/vectors/upstream-payment-requests.json` with implementation code.
- [ ] Pass schema and adapter contract tests.
- [ ] Run request-loss, response-loss, duplicate-storm, and restart lanes.
- [ ] Scan JSON, JUnit, and HTML reports for bearer material.
- [ ] Document unsupported profiles in capabilities.

Start with T0. Add funded wallet and receiver operations before claiming T1 or a higher tier.
