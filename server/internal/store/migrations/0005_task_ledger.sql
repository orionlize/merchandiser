-- Per-task virtual positions on follower accounts (several tasks may share one
-- account), and sampled cumulative task PnL for ranges / sparklines.
CREATE TABLE IF NOT EXISTS task_positions (
  task_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  base TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT '0',
  avg_px TEXT NOT NULL DEFAULT '0',
  realized TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, connection_id, base)
);
CREATE TABLE IF NOT EXISTS task_pnl (
  task_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  pnl TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_pnl ON task_pnl(task_id, ts);
