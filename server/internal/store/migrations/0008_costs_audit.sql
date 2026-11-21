-- Exact trading costs per task ("费用明细"): exchange-reported fees of the
-- task's own fills and hourly funding, allocated to tasks by their share of
-- the account position. Booked into the ledger (task_positions) and the open
-- or just-closed round trip (task_trips).
ALTER TABLE task_positions ADD COLUMN fees TEXT NOT NULL DEFAULT '0';
ALTER TABLE task_positions ADD COLUMN funding TEXT NOT NULL DEFAULT '0';
ALTER TABLE task_trips ADD COLUMN fees TEXT NOT NULL DEFAULT '0';
ALTER TABLE task_trips ADD COLUMN funding TEXT NOT NULL DEFAULT '0';
ALTER TABLE orders ADD COLUMN fee TEXT;
CREATE TABLE IF NOT EXISTS task_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  base TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- fee | funding
  amount TEXT NOT NULL,           -- fee: paid (positive) or rebate; funding: received (positive) or paid
  rate TEXT,                      -- fee: fee / notional; funding: hourly rate
  qty TEXT,                       -- fill size or position size the funding was charged on
  px TEXT,
  maker INTEGER,
  dir TEXT,                       -- open_long | close_long | open_short | close_short | flip_long | flip_short
  order_id INTEGER,
  ref TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_task_costs ON task_costs(task_id, ts);
-- Operation audit log ("操作审计"): every mutating command, redacted.
CREATE TABLE IF NOT EXISTS op_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  command TEXT NOT NULL,
  summary TEXT,
  ok INTEGER NOT NULL,
  error TEXT,
  ip TEXT,
  ua TEXT,
  otp INTEGER NOT NULL DEFAULT 0,
  sensitive INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_op_log_ts ON op_log(ts);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
