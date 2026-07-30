ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS redemption_starts integer NOT NULL DEFAULT 0
  CHECK (redemption_starts >= 0 AND redemption_starts <= 1000);
