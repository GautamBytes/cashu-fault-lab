CREATE INDEX IF NOT EXISTS recoverable_deliveries_v2
  ON deliveries (updated_at, delivery_id)
  WHERE phase IN ('prepared', 'mint_sent', 'recovery_blocked');

DROP INDEX IF EXISTS recoverable_deliveries;
