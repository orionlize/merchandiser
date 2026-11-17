// Typed wrappers over the server commands. Types mirror server/internal/api.
import { call as invoke } from "./server";

export type Platform = "okx" | "binance" | "gate" | "hyperliquid" | "paper";

export interface Permissions {
  read: boolean;
  trade: boolean;
  withdraw: boolean | null;
  transfer: boolean | null;
  ip_restricted: boolean | null;
  note: string | null;
}

export interface ConnectionInfo {
  equity: string;
  available: string;
  one_way: boolean;
  margin_mode: string;
  perms: Permissions;
  latency_ms: number;
  clock_skew_ms: number;
  margin_asset: string;
}

export interface HealthEntry {
  platform: Platform;
  latency_ms: number | null;
  last_ok: number | null;
  last_error: string | null;
  last_error_at: number | null;
}

export interface Health {
  platforms: HealthEntry[];
  estopped: boolean;
  running: number;
  locked: boolean;
  secret_backend: "keychain" | "encrypted_file";
  /** Error alerts in the last 5 minutes. */
  recent_errors: number;
  secrets_locked: boolean;
}

export interface Check {
  level: "ok" | "warn" | "error" | "info";
  text: string;
  action: string | null;
}

export interface Validation {
  ok: boolean;
  checks: Check[];
  info: ConnectionInfo | null;
}

export interface ConnectionInput {
  id?: string;
  platform: Platform;
  alias: string;
  testnet: boolean;
  api_key: string;
  secret: string;
  passphrase?: string | null;
  proxy?: string | null;
  paper_initial?: string | null;
}

export interface Connection {
  id: string;
  platform: Platform;
  alias: string;
  testnet: boolean;
  key_hint: string;
  proxy: string | null;
  perms: Permissions | null;
  one_way: boolean | null;
  margin_mode: string | null;
  equity: string | null;
  available: string | null;
  upnl: string | null;
  today_pnl: string | null;
  equity_ts: number | null;
  latency_ms: number | null;
  source_count: number;
  task_count: number;
}

export interface Source {
  id: string;
  kind: "api" | "hl_address" | "lead_trader";
  name: string;
  platform: Platform;
  connection_id: string | null;
  address: string | null;
  testnet: boolean;
  created_at: number;
  connection_alias: string | null;
  task_count: number;
  /** Public profile page (lead traders). */
  url: string | null;
  /** Lead traders: "fills" = positions reconstructed from public fills. */
  lead_mode: "positions" | "fills" | null;
}

export interface LeadProbe {
  platform: Platform;
  id: string;
  nickname: string;
  positions_public: boolean;
  fills_public: boolean;
  last_fill_ms: number | null;
  equity: string | null;
}

export interface LeadSummary {
  platform: Platform;
  id: string;
  nickname: string;
  avatar: string | null;
  aum: string | null;
  copiers: number | null;
  max_copiers: number | null;
  roi_pct: string | null;
  pnl: string | null;
  positions_public: boolean | null;
  url: string | null;
}

export interface Position {
  base: string;
  symbol: string;
  size: string;
  entry_px: string;
  mark_px: string;
  leverage: string | null;
  upnl: string;
}

export interface OpenOrder {
  id: string;
  client_id: string | null;
  base: string;
  symbol: string;
  buy: boolean;
  qty: string;
  orig_qty: string;
  price: string;
  trigger_px: string | null;
  kind: "limit" | "stop_market" | "take_profit_market" | "other";
  reduce_only: boolean;
  mirrored_to: number;
}

/** History rebuild of a "fills" lead trader. */
export interface Backfill {
  running: boolean;
  /** Fills fetched so far / fills the venue lists. */
  fetched: number;
  total: number;
  error: string | null;
  finished_at: number | null;
  /** Oldest fill counted, once finished. */
  from: number | null;
}

export interface SourceDetail {
  equity: string;
  notional: string;
  positions: Position[];
  orders: OpenOrder[];
  ts: number;
  /** Fill reconstruction progress ("fills" lead traders). */
  fills: { anchor: number; last_fill_at: number | null; applied: number; backfill: Backfill | null } | null;
}

export type SizingMode = "equity_ratio" | "fixed_multiple" | "fixed_notional";
export interface Sizing {
  mode: SizingMode;
  k: string;
  notional: string;
}
export interface Leverage {
  mode: "follow" | "fixed";
  value: number;
  cap: number;
}
export interface Rules {
  sizing: Sizing;
  leverage: Leverage;
  whitelist: string[];
  blacklist: string[];
  direction: "both" | "long_only" | "short_only";
  reverse: boolean;
  start: "new_only" | "sync_existing";
  stop: "keep" | "close_all";
  min_change_usdt: string;
  exec: "market" | "limit_ioc";
  mirror: { enabled: boolean; grace_ms: number; max_deviation_pct: string };
  reconcile_secs: number;
  tolerance_pct: string;
  reconcile_mode: "auto_fix" | "alert_only";
}
export interface Risk {
  max_symbol_notional: string | null;
  max_total_notional: string | null;
  max_slippage_pct: string;
  daily_loss_limit: string | null;
  total_loss_limit: string | null;
  close_on_loss: boolean;
  source_lost_secs: number;
  source_lost_action: "keep" | "pause" | "close";
}
export interface FollowerOverride {
  sizing?: Sizing | null;
  leverage?: Leverage | null;
}
export interface FollowerSpec {
  connection_id: string;
  overrides?: FollowerOverride | null;
}

export interface CompareRow {
  base: string;
  connection_id: string;
  alias: string;
  src: string;
  target: string | null;
  actual: string | null;
  deviation: string | null;
  state: "synced" | "pending" | "expected" | "dust" | "skipped" | "error" | "ignored";
  note: string;
}

export interface TaskLive {
  source_connected: boolean;
  source_equity: string;
  source_notional: string;
  target_notional: string;
  actual_notional: string;
  deviation_pct: string;
  last_reconcile: number | null;
  last_error: string | null;
  rows: CompareRow[];
  followers: { connection_id: string; alias: string; equity: string; upnl: string; notional: string }[];
  paused: boolean;
}

export interface TaskFollower {
  connection_id: string;
  alias: string;
  platform: Platform;
  testnet: boolean;
  overrides: FollowerOverride | null;
}

export interface TaskSummary {
  id: string;
  name: string;
  status: "running" | "paused" | "stopped";
  pause_reason: string | null;
  source_id: string;
  source_name: string;
  source_kind: Source["kind"];
  source_platform: Platform;
  source_address: string | null;
  followers: TaskFollower[];
  rules: Rules;
  risk: Risk;
  created_at: number;
  started_at: number | null;
  stopped_at: number | null;
  today_pnl: string | null;
  total_pnl: string | null;
  live: TaskLive | null;
}

export interface OrderRow {
  id: number;
  task_id: string;
  signal_id: number | null;
  connection_id: string | null;
  ts: number;
  base: string;
  symbol: string | null;
  buy: boolean | null;
  qty: string | null;
  order_type: string | null;
  price: string | null;
  reduce_only: boolean;
  client_id: string | null;
  status: string;
  fill_px: string | null;
  fill_qty: string | null;
  ref_px: string | null;
  slippage_bps: string | null;
  latency_ms: number | null;
  reason: string | null;
  purpose: string;
}

export interface SignalWithOrders {
  id: number;
  task_id: string;
  ts: number;
  base: string;
  kind: string;
  from_size: string | null;
  to_size: string | null;
  text: string;
  orders: OrderRow[];
}

export interface Mirror {
  id: number;
  task_id: string;
  connection_id: string;
  source_order_id: string;
  client_id: string | null;
  base: string;
  buy: boolean;
  kind: "limit" | "stop" | "take_profit";
  src_qty: string;
  src_price: string | null;
  qty: string | null;
  price: string | null;
  trigger_px: string | null;
  filled: string;
  status: "live" | "filled" | "grace" | "done" | "not_mirrored" | "failed";
  note: string | null;
  grace_until: number | null;
  created_at: number;
  updated_at: number;
  alias: string;
}

export interface TaskDetail extends TaskSummary {
  latency_p95: number | null;
  mirrors: Mirror[];
  signals: SignalWithOrders[];
}

export interface Alert {
  id: number;
  ts: number;
  level: "info" | "ok" | "warn" | "error";
  task_id: string | null;
  connection_id: string | null;
  title: string;
  detail: string | null;
}

export interface Overview {
  total_equity: string;
  follower_count: number;
  today_pnl: string;
  today_pnl_pct: string;
  upnl: string;
  available: string;
  notional: string;
  latency_p95: number | null;
  accounts: { id: string; alias: string; platform: Platform; testnet: boolean; equity: string | null; today_pnl: string | null }[];
  tasks: TaskSummary[];
  alerts: Alert[];
  today: { signals: number; orders: number; avg_slippage_pct: string | null; skipped: number; failed: number };
  estopped: boolean;
}

export interface Preview {
  source_equity: string;
  sample_base: string | null;
  source_positions: number;
  rows: { connection_id: string; alias: string; equity: string; available: string; ratio_pct: string | null; sample_target: string | null; sync_notional: string }[];
  warnings: string[];
  sync_notional: string;
  sync_margin_pct: string;
}

export interface LogFilter {
  range: "today" | "7d" | "30d" | "all";
  task_id?: string | null;
  connection_id?: string | null;
  status?: "all" | "skipped" | "failed";
  fills_only?: boolean;
  limit?: number;
  offset?: number;
}

export interface LogRow {
  id: number;
  ts: number;
  task_id: string;
  task_name: string | null;
  signal_text: string | null;
  connection_id: string | null;
  alias: string | null;
  base: string;
  symbol: string | null;
  buy: boolean | null;
  qty: string | null;
  order_type: string | null;
  price: string | null;
  reduce_only: boolean;
  status: string;
  fill_px: string | null;
  fill_qty: string | null;
  slippage_bps: string | null;
  latency_ms: number | null;
  reason: string | null;
  purpose: string;
}

export interface LogPage {
  rows: LogRow[];
  total: number;
  skipped: number;
  failed: number;
}

export interface PnlRow {
  connection_id: string;
  alias: string;
  platform: Platform;
  start_equity: string | null;
  end_equity: string | null;
  pnl: string | null;
  fills: number;
  volume: string;
}

export interface Settings {
  language: "zh" | "en";
  theme: "dark" | "light" | "system";
  autostart: boolean;
  prevent_sleep: boolean;
  app_lock: boolean;
  idle_lock_minutes: number;
  log_retention_days: number;
  notifications: boolean;
  close_confirm_mode: string;
}

export interface SymbolRow {
  base: string;
  manual: boolean;
  cells: Record<string, { symbol: string | null; coin_per_unit: string | null; px_unit: string | null; manual: boolean }>;
}

export interface TaskInput {
  name: string;
  source_id: string;
  followers: FollowerSpec[];
  rules: Rules;
  risk: Risk;
  start_now: boolean;
}

export const api = {
  health: () => invoke<Health>("get_health"),
  estop: () => invoke<void>("emergency_stop"),
  releaseEstop: () => invoke<void>("release_estop"),
  closeAll: () => invoke<void>("close_all_positions"),

  validateConnection: (input: ConnectionInput) => invoke<Validation>("validate_connection", { input }),
  saveConnection: (input: ConnectionInput, force = false) => invoke<string>("save_connection", { input, force }),
  connections: () => invoke<Connection[]>("list_connections"),
  testConnection: (id: string) => invoke<Validation>("test_connection", { id }),
  switchOneWay: (id: string | null, input?: ConnectionInput) => invoke<void>("switch_one_way", { id, input }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),

  sources: () => invoke<Source[]>("list_sources"),
  addSource: (input: { kind: Source["kind"]; name: string; connection_id?: string | null; address?: string | null; testnet?: boolean; platform?: Platform | null; lead_mode?: "fills" | null }) => invoke<string>("add_source", { input }),
  probeLeadTrader: (platform: Platform, id: string) => invoke<LeadProbe>("probe_lead_trader", { platform, id }),
  searchLeadTraders: (platform: Platform, query: string, page?: number) => invoke<LeadSummary[]>("search_lead_traders", { platform, query, page: page ?? null }),
  deleteSource: (id: string) => invoke<void>("delete_source", { id }),
  sourceDetail: (id: string) => invoke<SourceDetail>("source_detail", { id }),
  /** Rebuild a "fills" lead trader from its whole public trade history (runs in the background). */
  backfillSource: (id: string) => invoke<void>("backfill_source", { id }),
  paperTrade: (input: { connection_id: string; base: string; action: "open" | "close" | "cancel"; buy?: boolean; notional?: string | null; price?: string | null; leverage?: number | null; order_id?: string | null }) =>
    invoke<void>("paper_trade", { input }),

  tasks: () => invoke<TaskSummary[]>("list_tasks"),
  task: (id: string) => invoke<TaskDetail>("get_task", { id }),
  createTask: (input: TaskInput) => invoke<string>("create_task", { input }),
  updateTask: (id: string, update: { name?: string; rules?: Rules; risk?: Risk; followers?: FollowerSpec[] }) => invoke<void>("update_task", { id, update }),
  taskAction: (id: string, action: "start" | "resume" | "pause" | "stop" | "reconcile", closePositions?: boolean) =>
    invoke<void>("task_action", { id, action, close_positions: closePositions ?? null }),
  deleteTask: (id: string) => invoke<void>("delete_task", { id }),
  preview: (input: { source_id: string; followers: FollowerSpec[]; rules: Rules }) => invoke<Preview>("preview_task", { input }),

  overview: () => invoke<Overview>("get_overview"),
  alerts: (limit = 50) => invoke<Alert[]>("list_alerts", { limit }),
  logs: (filter: LogFilter) => invoke<LogPage>("query_logs", { filter }),
  exportCsv: (filter: LogFilter) => invoke<{ csv: string; rows: number }>("export_logs_csv", { filter }),
  pnl: (range: LogFilter["range"]) => invoke<PnlRow[]>("pnl_report", { range }),
  equitySeries: (args: { connectionId?: string; sourceId?: string; since?: number }) =>
    invoke<[number, string][]>("equity_series", { connection_id: args.connectionId ?? null, source_id: args.sourceId ?? null, since: args.since ?? null }),

  settings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<Settings>("set_settings", { settings }),
  setLockPassword: (password: string | null) => invoke<void>("set_lock_password", { password }),
  lock: () => invoke<boolean>("lock_app"),
  unlock: (password: string) => invoke<void>("unlock_app", { password }),
  unlockSecrets: (password: string) => invoke<void>("unlock_secrets", { password }),
  symbolMap: (query?: string) => invoke<SymbolRow[]>("symbol_map", { query: query ?? null }),
  setSymbolOverride: (base: string, platform: Platform, symbol: string | null, disabled: boolean, clear = false) =>
    invoke<void>("set_symbol_override", { base, platform, symbol, disabled, clear }),
  regenerateSymbols: () => invoke<void>("regenerate_symbol_map"),
  symbolsUpdatedAt: () => invoke<number | null>("symbols_updated_at"),
  exportConfig: () => invoke<unknown>("export_config"),
  importConfig: (config: unknown) => invoke<string>("import_config", { config }),
};

export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
