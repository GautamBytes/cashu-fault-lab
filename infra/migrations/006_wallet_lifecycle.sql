CREATE TABLE IF NOT EXISTS cashu_lifecycle_runs (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  seed_fingerprint char(64) NOT NULL CHECK (seed_fingerprint ~ '^[0-9a-f]{64}$'),
  seed_ciphertext bytea NOT NULL CHECK (octet_length(seed_ciphertext) > 0),
  seed_nonce bytea NOT NULL CHECK (octet_length(seed_nonce) = 12),
  seed_tag bytea NOT NULL CHECK (octet_length(seed_tag) = 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id)
);

CREATE TABLE IF NOT EXISTS cashu_lifecycle_operations (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  operation_id char(22) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mint', 'swap', 'send', 'receive', 'melt', 'restore', 'reconcile')),
  mint text NOT NULL,
  unit text NOT NULL,
  intent_hash char(64) NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  phase text NOT NULL CHECK (phase IN ('created', 'prepared', 'submitted', 'ambiguous', 'reconciling', 'succeeded', 'failed_definitive', 'recovery_blocked')),
  request_hash char(64) CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  quote_hash char(64) CHECK (quote_hash IS NULL OR quote_hash ~ '^[0-9a-f]{64}$'),
  output_plan_hash char(64) CHECK (output_plan_hash IS NULL OR output_plan_hash ~ '^[0-9a-f]{64}$'),
  record_ciphertext bytea NOT NULL CHECK (octet_length(record_ciphertext) > 0),
  record_nonce bytea NOT NULL CHECK (octet_length(record_nonce) = 12),
  record_tag bytea NOT NULL CHECK (octet_length(record_tag) = 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id, operation_id),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES cashu_lifecycle_runs (tenant_id, run_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cashu_lifecycle_effects (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  effect_id text NOT NULL,
  operation_id char(22) NOT NULL,
  data_hash char(64) NOT NULL CHECK (data_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, run_id, effect_id),
  FOREIGN KEY (tenant_id, run_id, operation_id)
    REFERENCES cashu_lifecycle_operations (tenant_id, run_id, operation_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cashu_lifecycle_proofs (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  proof_id char(64) NOT NULL CHECK (proof_id ~ '^[0-9a-f]{64}$'),
  operation_id char(22) NOT NULL,
  state text NOT NULL CHECK (state IN ('UNSPENT', 'PENDING', 'SPENT')),
  PRIMARY KEY (tenant_id, run_id, proof_id),
  FOREIGN KEY (tenant_id, run_id, operation_id)
    REFERENCES cashu_lifecycle_operations (tenant_id, run_id, operation_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS cashu_lifecycle_output_plans (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  output_plan_hash char(64) NOT NULL CHECK (output_plan_hash ~ '^[0-9a-f]{64}$'),
  operation_id char(22) NOT NULL,
  PRIMARY KEY (tenant_id, run_id, output_plan_hash),
  UNIQUE (tenant_id, run_id, operation_id, output_plan_hash),
  FOREIGN KEY (tenant_id, run_id, operation_id)
    REFERENCES cashu_lifecycle_operations (tenant_id, run_id, operation_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cashu_lifecycle_recoverable
  ON cashu_lifecycle_operations (tenant_id, run_id, updated_at, operation_id)
  WHERE phase IN ('submitted', 'ambiguous', 'reconciling');
