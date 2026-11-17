CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  alias TEXT NOT NULL UNIQUE,
  testnet INTEGER NOT NULL DEFAULT 0,
  key_hint TEXT NOT NULL DEFAULT '',
  proxy TEXT,
  perms_json TEXT,
  one_way INTEGER,
  margin_mode TEXT,
  paper_initial TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- api | hl_address | lead_trader
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  connection_id TEXT REFERENCES connections(id),
  address TEXT,
  testnet INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  status TEXT NOT NULL,          -- running | paused | stopped
  rules_json TEXT NOT NULL,
  risk_json TEXT NOT NULL,
  pause_reason TEXT,
  baseline_json TEXT,            -- symbols ignored under the "new positions only" start policy
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  stopped_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_followers (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  override_json TEXT,
  start_equity TEXT,
  PRIMARY KEY (task_id, connection_id)
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  base TEXT NOT NULL,
  kind TEXT NOT NULL,            -- open | add | reduce | close | flip | risk | reconcile
  from_size TEXT,
  to_size TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_task_ts ON signals(task_id, ts);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  signal_id INTEGER,
  connection_id TEXT,
  ts INTEGER NOT NULL,
  base TEXT NOT NULL,
  symbol TEXT,
  buy INTEGER,
  qty TEXT,
  order_type TEXT,
  price TEXT,
  reduce_only INTEGER NOT NULL DEFAULT 0,
  client_id TEXT,
  status TEXT NOT NULL,          -- filled | partial | open | failed | skipped | cancelled
  fill_px TEXT,
  fill_qty TEXT,
  ref_px TEXT,
  slippage_bps TEXT,
  latency_ms INTEGER,
  reason TEXT,
  purpose TEXT NOT NULL DEFAULT 'sync'  -- sync | mirror | close | reconcile
);
CREATE INDEX IF NOT EXISTS idx_orders_ts ON orders(ts);
CREATE INDEX IF NOT EXISTS idx_orders_task ON orders(task_id, ts);

CREATE TABLE IF NOT EXISTS mirrors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  client_id TEXT,
  base TEXT NOT NULL,
  buy INTEGER NOT NULL,
  kind TEXT NOT NULL,
  src_qty TEXT NOT NULL,
  src_price TEXT,
  qty TEXT,
  price TEXT,
  trigger_px TEXT,
  filled TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL,          -- live | grace | done | not_mirrored | failed
  note TEXT,
  grace_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mirrors_task ON mirrors(task_id, status);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  connection_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  equity TEXT NOT NULL,
  available TEXT NOT NULL,
  upnl TEXT NOT NULL,
  notional TEXT NOT NULL DEFAULT '0'
);
CREATE INDEX IF NOT EXISTS idx_equity_conn_ts ON equity_snapshots(connection_id, ts);

CREATE TABLE IF NOT EXISTS symbol_map (
  base TEXT NOT NULL,
  platform TEXT NOT NULL,
  symbol TEXT,                   -- NULL with disabled=1 means "no mapping"
  disabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (base, platform)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,           -- info | ok | warn | error
  task_id TEXT,
  connection_id TEXT,
  title TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_state (
  connection_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_equity (
  source_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  equity TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_equity ON source_equity(source_id, ts);
