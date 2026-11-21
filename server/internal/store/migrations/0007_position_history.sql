-- Closed round trips of each task's ledger shares ("历史仓位"): a share
-- opened from flat and brought back to flat (or flipped). The open trip's
-- running totals live on task_positions.trip_json.
ALTER TABLE task_positions ADD COLUMN trip_json TEXT;
CREATE TABLE IF NOT EXISTS task_trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  base TEXT NOT NULL,
  side TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER NOT NULL,
  max_size TEXT NOT NULL,
  entry_px TEXT NOT NULL,
  exit_px TEXT NOT NULL,
  realized TEXT NOT NULL,
  leverage TEXT,
  reason TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_trips ON task_trips(task_id, closed_at);
