-- Lead traders followed by reconstructing positions from public fills
-- (Binance traders who hide positions).
ALTER TABLE sources ADD COLUMN lead_mode TEXT; -- NULL/'positions' | 'fills'

CREATE TABLE IF NOT EXISTS lead_fill_state (
  source_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
