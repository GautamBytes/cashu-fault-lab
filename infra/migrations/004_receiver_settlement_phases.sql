ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_phase_check;

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_phase_check
  CHECK (
    phase IN (
      'prepared',
      'mint_sent',
      'recovery_blocked',
      'outputs_persisted',
      'credited',
      'settled',
      'rejected'
    )
  );

DROP INDEX IF EXISTS recoverable_deliveries_v2;

CREATE INDEX IF NOT EXISTS recoverable_deliveries_v3
  ON deliveries (updated_at, delivery_id)
  WHERE phase IN (
    'prepared',
    'mint_sent',
    'recovery_blocked',
    'outputs_persisted',
    'credited'
  );
