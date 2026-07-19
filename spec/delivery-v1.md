# Cashu Delivery V1 Lab Profile

Status: experimental interoperability profile. This document is not an accepted Cashu NUT.

The profile adds retry-safe delivery identity and receipts to existing Cashu payment requests. It does not change mint cryptography or mint endpoints. Normative words such as MUST and SHOULD use their RFC 2119 meanings.

## Upstream basis

The exact upstream revisions used by the lab are recorded in [`upstream-lock.json`](./upstream-lock.json).

- [NUT-18](https://github.com/cashubtc/nuts/blob/fccb68e9129de5348003f573dc97e1ee380a1076/18.md): payment requests, HTTP POST, and Nostr/NIP-17 transport.
- [NUT-02](https://github.com/cashubtc/nuts/blob/fccb68e9129de5348003f573dc97e1ee380a1076/02.md): keysets and input fees.
- [NUT-03](https://github.com/cashubtc/nuts/blob/fccb68e9129de5348003f573dc97e1ee380a1076/03.md): swap-to-receive settlement.
- [NUT-07](https://github.com/cashubtc/nuts/blob/fccb68e9129de5348003f573dc97e1ee380a1076/07.md): proof state evidence.
- [NUT-09](https://github.com/cashubtc/nuts/blob/fccb68e9129de5348003f573dc97e1ee380a1076/09.md): deterministic restore.
- [NUT-19](https://github.com/cashubtc/nuts/blob/fccb68e9129de5348003f573dc97e1ee380a1076/19.md): cached successful mint responses.

NUT-19 protects retries to supporting mint endpoints. It does not make the merchant transport or merchant ledger idempotent; this profile supplies those layers.

## Identifiers

Request and delivery IDs MUST be independently generated 128-bit random values encoded as unpadded canonical base64url. The wire form is 22 characters and matches `^[A-Za-z0-9_-]{21}[AQgw]$`.

- `request_id` identifies merchant intent.
- `delivery_id` identifies one sender delivery attempt across all retries and transports.
- A retry MUST reuse the original `delivery_id` and identical payload bytes.
- A new logical payment MUST use a new `delivery_id`.

## NUT-18 negotiation

A delivery-aware request uses the standard compact NUT-18 fields and MUST include `i`, `a`, `u`, `s`, and at least one transport `t`. At least one transport MUST contain these exact tags:

```json
[
  ["delivery", "1"],
  ["expires_at", "1784400300"]
]
```

`expires_at` is a canonical base-10 Unix timestamp. It MUST be later than receiver time and no more than 86,400 seconds in the future when created. Unknown delivery versions are unsupported, not malformed: a wallet MAY try another transport or report that the profile is unsupported. A malformed version-one negotiation MUST fail closed.

The full structural request contract is [`delivery-request.schema.json`](./schemas/delivery-request.schema.json). Generic NUT-18 tags remain extensible; the two profile tags are exact pairs.

## Payload

The HTTP body or NIP-17 message content is UTF-8 JSON:

```json
{
  "id": "AAECAwQFBgcICQoLDA0ODw",
  "memo": "order-42",
  "mint": "https://mint.example",
  "unit": "sat",
  "proofs": [],
  "delivery": {
    "v": 1,
    "id": "EBESExQVFhcYGRobHB0eHw",
    "created_at": 1784399400,
    "expires_at": 1784400300
  }
}
```

Rules:

- Encoded payload size MUST NOT exceed 65,536 bytes.
- The proof array MUST NOT exceed 256 elements.
- Top-level and `delivery` fields are closed; unknown fields are rejected. Proof objects remain extension-friendly for Cashu witnesses and DLEQ data.
- `mint` MUST normalize under the lab mint URL rules. Non-loopback HTTP, credentials, query strings, fragments, whitespace, and non-HTTP schemes are rejected.
- The validity window MUST be positive and at most 86,400 seconds.
- Receivers allow 60 seconds of clock skew for creation and expiration checks.
- The payload MUST match the request ID, unit, allowed mint set, expiry, and exact requested net amount.
- The exact net amount is `sum(proof.amount) - ceil(sum(input_fee_ppk)/1000)`, with integer arithmetic and one rounding operation across all inputs.

The structural contract is [`delivery-payload.schema.json`](./schemas/delivery-payload.schema.json). Timestamp relationships, request binding, mint keyset fees, proof validity, and amount equality are semantic checks outside JSON Schema.

## Fingerprints

The payload hash is SHA-256 over deterministic CBOR using the domain string `cashu-delivery-v1/payload`. Inputs are request ID, nullable memo, normalized mint URL, unit, proof array, version, creation time, and expiration time in that order.

The proof-set hash is SHA-256 over deterministic CBOR using `cashu-delivery-v1/proof-set`, normalized mint URL, unit, and sorted unique proof `Y` points. Implementations MUST derive `Y` using the Cashu hash-to-curve construction; they MUST NOT use secrets or promises as an interchangeable proof identity.

Normative byte vectors are in [`delivery-v1-fingerprints.json`](./vectors/delivery-v1-fingerprints.json).

## Receiver classification

Classification occurs transactionally before redemption:

1. Existing same `delivery_id`, request ID, payload hash, and proof-set hash: return the stored receipt. Do not redeem or credit again.
2. Existing same `delivery_id` with different binding: reject as `delivery_conflict`.
3. Active proof claim under another delivery: reject as `proof_conflict`.
4. Active reservation under a single-use request: reject as `single_use_conflict`.
5. Otherwise, atomically reserve request and proof identities, store a version-one `processing/accepted` receipt, then start redemption.

Claims MUST be unique in durable storage. Process-local locks are insufficient.

## Redemption and settlement

The receiver redeems by swapping the input proofs for new outputs. Per NUT-03, the payment becomes settled only after the receiver has obtained and unblinded replacement proofs. An HTTP 200 from the mint without recoverable outputs is not settlement.

Before a swap, the receiver MUST durably store deterministic output derivation state. After an ambiguous mint outcome, it MUST recover using, in order:

1. a matching cached NUT-19 response when the mint advertises it;
2. NUT-09 restore using the persisted derivation state;
3. NUT-07 proof-state evidence to distinguish unspent, pending, and spent inputs.

NUT-07 is snapshot evidence, not an idempotency fence. After an ambiguous swap, even an all-`UNSPENT` response MUST NOT authorize a new swap request. The receiver may replay only the exact request under an active NUT-19 cache guarantee; otherwise it remains recovery-blocked until NUT-09 or NUT-19 recovers the intended outputs.

If inputs may have been consumed but outputs are not yet recovered, the receipt stays `processing/recovery_blocked`. It MUST NOT become rejected and MUST NOT create a merchant credit.

## Receipts

Every accepted request returns a receipt conforming to [`delivery-receipt.schema.json`](./schemas/delivery-receipt.schema.json). Status is monotonic:

```text
processing/accepted -> processing/redeeming -> settled/settled
processing/accepted -> rejected/{invalid|expired|conflict}
processing/redeeming -> processing/recovery_blocked -> settled/settled
```

The first receipt has `status_version = 1`. Every material transition increments exactly once. Terminal receipts cannot change. An identical retry returns the stored receipt, including the same version.

## Transport

HTTP uses NUT-18 `post`: JSON request body, JSON receipt response, and a stable delivery-status resource. A lost response is recovered by resending the identical payload or querying by delivery ID.

Nostr uses the NUT-18 `nostr` transport and NIP-17 indication `g: [["n", "17"]]`. Messages MUST use current NIP-17/NIP-59 wrapping. HTTP and Nostr delivery of the same logical attempt share the same delivery ID and fingerprint, so transport failover cannot create another credit.

The current upstream NUT-26 text has encryption/key and field-name differences from current NUT-18/NIP-17/NIP-59. The lab reports this as a compatibility mismatch; it does not silently reinterpret one format as the other.

## Adapter boundary

Wallet implementations integrate through the language-neutral HTTP routes:

- `GET /v1/capabilities`
- `POST /v1/reset`
- `POST /v1/requests`
- `POST /v1/send`
- `GET /v1/deliveries/:id`
- `GET /v1/ledger`
- `GET /v1/proofs`

The TypeScript client contract is a convenience layer, not a requirement. Any implementation that satisfies the JSON schemas and routes can participate.
