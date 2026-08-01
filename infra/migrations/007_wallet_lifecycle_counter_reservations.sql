ALTER TABLE cashu_lifecycle_proofs
  ADD COLUMN IF NOT EXISTS reserved_by_operation_id char(22);

CREATE TABLE IF NOT EXISTS cashu_lifecycle_seed_counters (
  tenant_id text NOT NULL,
  seed_fingerprint char(64) NOT NULL CHECK (seed_fingerprint ~ '^[0-9a-f]{64}$'),
  keyset_id text NOT NULL,
  next_counter bigint NOT NULL CHECK (next_counter >= 0),
  PRIMARY KEY (tenant_id, seed_fingerprint, keyset_id)
);

CREATE TABLE IF NOT EXISTS cashu_lifecycle_counter_reservations (
  tenant_id text NOT NULL,
  seed_fingerprint char(64) NOT NULL CHECK (seed_fingerprint ~ '^[0-9a-f]{64}$'),
  keyset_id text NOT NULL,
  reservation_id text NOT NULL,
  start_counter bigint NOT NULL CHECK (start_counter >= 0),
  counter_count bigint NOT NULL CHECK (counter_count > 0),
  PRIMARY KEY (tenant_id, seed_fingerprint, keyset_id, reservation_id)
);
