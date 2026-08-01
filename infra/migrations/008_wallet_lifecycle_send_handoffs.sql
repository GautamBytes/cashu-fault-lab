CREATE TABLE IF NOT EXISTS cashu_lifecycle_send_handoffs (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  operation_id char(22) NOT NULL,
  recipient text NOT NULL CHECK (length(recipient) > 0),
  token_hash char(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_ciphertext bytea NOT NULL CHECK (octet_length(token_ciphertext) > 0),
  token_nonce bytea NOT NULL CHECK (octet_length(token_nonce) = 12),
  token_tag bytea NOT NULL CHECK (octet_length(token_tag) = 16),
  claimed_by text,
  claimed_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id, operation_id),
  FOREIGN KEY (tenant_id, run_id, operation_id)
    REFERENCES cashu_lifecycle_operations (tenant_id, run_id, operation_id)
    ON DELETE CASCADE
);
