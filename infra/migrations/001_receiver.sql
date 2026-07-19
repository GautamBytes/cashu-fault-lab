CREATE TABLE IF NOT EXISTS payment_requests (
  request_id text PRIMARY KEY,
  amount bigint NOT NULL CHECK (amount >= 0),
  unit text NOT NULL CHECK (length(unit) > 0),
  mints jsonb NOT NULL CHECK (jsonb_typeof(mints) = 'array'),
  single_use boolean NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES payment_requests(request_id),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  proof_set_hash char(64) NOT NULL CHECK (proof_set_hash ~ '^[0-9a-f]{64}$'),
  mint text NOT NULL,
  unit text NOT NULL,
  amount bigint NOT NULL CHECK (amount >= 0),
  single_use boolean NOT NULL,
  phase text NOT NULL CHECK (phase IN ('prepared', 'mint_sent', 'recovery_blocked', 'settled', 'rejected')),
  receipt jsonb NOT NULL,
  swap_plan_ciphertext bytea NOT NULL CHECK (octet_length(swap_plan_ciphertext) > 0),
  swap_plan_nonce bytea NOT NULL CHECK (octet_length(swap_plan_nonce) = 12),
  swap_plan_tag bytea NOT NULL CHECK (octet_length(swap_plan_tag) = 16),
  replacement_plan_hash text,
  replacement_ciphertext bytea,
  replacement_nonce bytea CHECK (replacement_nonce IS NULL OR octet_length(replacement_nonce) = 12),
  replacement_tag bytea CHECK (replacement_tag IS NULL OR octet_length(replacement_tag) = 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (phase = 'settled' AND replacement_plan_hash IS NOT NULL AND replacement_ciphertext IS NOT NULL AND replacement_nonce IS NOT NULL AND replacement_tag IS NOT NULL)
    OR phase <> 'settled'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_single_use_delivery
  ON deliveries (request_id)
  WHERE single_use AND phase <> 'rejected';

CREATE INDEX IF NOT EXISTS recoverable_deliveries
  ON deliveries (updated_at, delivery_id)
  WHERE phase IN ('mint_sent', 'recovery_blocked');

CREATE TABLE IF NOT EXISTS proof_claims (
  tenant_id text NOT NULL,
  mint text NOT NULL,
  unit text NOT NULL,
  proof_y_hmac char(64) NOT NULL CHECK (proof_y_hmac ~ '^[0-9a-f]{64}$'),
  delivery_id text NOT NULL REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, mint, unit, proof_y_hmac)
);

CREATE TABLE IF NOT EXISTS merchant_credits (
  delivery_id text PRIMARY KEY REFERENCES deliveries(delivery_id),
  credit_id text NOT NULL UNIQUE,
  request_id text NOT NULL REFERENCES payment_requests(request_id),
  amount bigint NOT NULL CHECK (amount >= 0),
  unit text NOT NULL,
  created_at bigint NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE IF NOT EXISTS receipt_outbox (
  id bigserial PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES deliveries(delivery_id),
  status_version integer NOT NULL CHECK (status_version >= 1),
  body jsonb NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, status_version)
);
