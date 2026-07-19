# Delivery Core Hardening Design

**Date:** 2026-07-19  
**Status:** Approved for implementation  
**Scope:** Harden the existing `delivery-core` foundation before building transport or persistence layers.

## 1. Goal

Make `delivery-core` a trustworthy, language-neutral boundary for the experimental `cashu-delivery-v1` profile. Equivalent HTTP/Nostr JSON payloads must produce identical fingerprints across implementations, malformed wire data must fail with stable errors, receipt state must remain monotonic under reordering, and the package must run under its declared Node.js runtime without relying on a test bundler.

This slice does not add HTTP, Nostr, a wallet, a mint client, a database, or merchant accounting.

## 2. Wire data and fingerprints

Fingerprint functions accept only the JSON data model used on the wire. Values such as `undefined`, `bigint`, functions, symbols, typed arrays, maps, non-finite numbers, fractional numbers, and unsafe integers are rejected before CBOR encoding. Unknown proof extension fields remain part of the fingerprint, but their values must recursively contain only null, booleans, strings, safe integers, arrays, and plain string-keyed objects.

The payload validator enforces canonical request IDs, a non-empty unit, at most 256 proofs, safe Unix-second timestamps, `created_at < expires_at`, and a maximum 24-hour validity window. The hash continues to preserve proof order and excludes the delivery ID as specified.

The package exposes deterministic preimage encoders alongside hash helpers so executable vectors can assert both canonical-CBOR bytes and SHA-256 digests. Checked-in vectors are generated independently and cover optional fields, map order, numeric boundaries, URL normalization, and invalid wire-only values.

## 3. Proof-set points

`proof_set_hash` accepts only branded compressed secp256k1 points created by a validating parser. Validation checks the 33-byte SEC1 form and asks Node/OpenSSL to decompress and re-compress the point; malformed, out-of-field, and off-curve inputs are rejected. Duplicate Y values within one proof set are invalid rather than being silently hashed.

## 4. Mint URL normalization

Version 1 normatively uses WHATWG URL parsing, followed by explicit policy checks. Raw leading/trailing whitespace, backslashes, userinfo, query delimiters, and fragment delimiters are rejected even when their components are empty. HTTP remains limited to `localhost`, `127.0.0.1`, and `[::1]`. HTTPS is required otherwise. Host and scheme are lowercase, default ports are removed by the parser, a root slash is removed, and one trailing slash is removed from a non-root path.

Cross-language vectors are normative for edge cases. Other implementations may use a different URL library only if they produce the same vector results.

## 5. Receipt boundary and state

Wire receipts use snake_case JSON. `parseDeliveryReceipt(unknown)` performs safe runtime validation and returns the camelCase internal model; `serializeDeliveryReceipt()` performs the inverse mapping. Unknown non-empty detail codes are accepted as diagnostic data for forward compatibility, while known version-1 codes are checked against their allowed status.

`assertReceiptTransition()` validates receiver-produced durable mutations: exact duplicates are allowed, real mutations increment `status_version` by exactly one, a version bump must change status or detail, identity fields never change, terminal states never change, and `processing/recovery_blocked` cannot become `rejected`.

`mergeObservedReceipt()` implements sender-side reordering behavior: stale lower versions are ignored, exact duplicates are idempotent, same-version conflicts fail, and a higher version replaces the prior observation. This separation lets receivers enforce exact durable history without preventing senders from missing intermediate receipts.

## 6. Package and repository developer experience

Source imports use Node-compatible `.js` specifiers. A build-specific TypeScript configuration emits ESM JavaScript and declarations to `dist`; package exports point only to those artifacts. A native Node consumer smoke test imports the built package without Vitest or Vite.

The root task graph gains a build task and no longer claims nonexistent test coverage output. Prettier ignores generated lockfiles/build artifacts, the existing plan is formatted, and CI runs frozen install, formatting, type checking, tests, build, and the consumer smoke test on Node 24 with pnpm 11.15.

## 7. Test strategy

Every behavior change follows red-green-refactor. Regression tests first reproduce the observed failures: JSON-equivalent proof objects hashing differently, invalid time windows hashing, invalid curve points passing, empty URL components passing, malformed receipt statuses throwing `TypeError`, illegal receipt mutations passing, and native Node import failure.

The final gate is: all unit/vector tests pass, TypeScript passes, the package builds, native Node imports `dist`, Prettier passes, Turbo runs without output warnings, and the production dependency audit reports no known vulnerabilities.

## 8. Deliberate exclusions

This hardening slice does not implement amount/fee calculation, duplicate classification backed by persistence, a full adapter contract, the independent oracle, sender/receiver services, mint recovery, fault injection, or Nostr. Those remain subsequent slices after these wire semantics are stable.
