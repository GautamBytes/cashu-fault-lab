CREATE TABLE IF NOT EXISTS cashu_test_crash_arms (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  component text NOT NULL CHECK (component IN ('sender', 'receiver')),
  boundary text NOT NULL,
  occurrence integer NOT NULL CHECK (occurrence >= 1 AND occurrence <= 1000000),
  hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
  consumed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id, component, boundary)
);

CREATE INDEX IF NOT EXISTS cashu_test_crash_arms_run_idx
  ON cashu_test_crash_arms (tenant_id, run_id, created_at);
