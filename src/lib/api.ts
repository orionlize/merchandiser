// Typed wrappers over the server commands. Types mirror server/internal/api.
import { call as invoke } from "./server";

export type Platform = "hyperliquid" | "paper";

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
  /** Two-step verification is on: the lock screen asks for a code. */
  totp_enabled?: boolean;
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
  kind: "api" | "hl_address";
  name: string;
  platform: Platform;
  connection_id: string | null;
  address: string | null;
  testnet: boolean;
  created_at: number;
  connection_alias: string | null;
  task_count: number;
}

export type PlazaWindow = "7d" | "30d" | "all";

export interface PlazaFactors {
  dd: number;
  hold: number;
  stable: number;
  size: number;
}

export interface PlazaWallet {
  address: string;
  name: string | null;
  equity: number;
  perf: Partial<Record<PlazaWindow, { pnl: number; roi: number; vlm: number }>>;
  analyzed: boolean;
  error?: string;
  scores: Partial<Record<PlazaWindow, { score: number; factors: PlazaFactors }>>;
  max_dd: Partial<Record<PlazaWindow, number>>;
  win_rate: number | null;
  avg_hold_sec: number | null;
  trades_per_day: number;
  hft: boolean;
  coins: string[];
  curves: Partial<Record<PlazaWindow, [number, number][]>>;
  favorite: boolean;
  source_id: string | null;
  task_id: string | null;
}

export interface PlazaList {
  status: { updated_at: number; analyzed: number; total: number; error?: string };
  wallets: PlazaWallet[];
}

export interface PlazaPosition {
  coin: string;
  size: number;
  entry_px: number;
  value: number;
  upnl: number;
  leverage: number;
}

export interface PlazaWalletDetail extends PlazaWallet {
  positions: PlazaPosition[];
  positions_error?: string;
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

export interface SourceDetail {
  equity: string;
  notional: string;
  positions: Position[];
  orders: OpenOrder[];
  ts: number;
}

export type SizingMode = "allocated" | "equity_ratio" | "fixed_multiple" | "fixed_notional";
export interface Sizing {
  mode: SizingMode;
  k: string;
  notional: string;
  /** Allocated mode: USDT capital per follower account. */
  capital?: string;
  /** Allocated mode: the task's realised PnL grows / shrinks the capital. */
  compound?: boolean;
}
export interface Leverage {
  mode: "follow" | "fixed";
  value: number;
  cap: number;
  margin?: "cross" | "isolated";
}
/** Per-share take profit / stop loss on ROE (%); null = off. sl_pct is positive. */
export interface TPSL {
  enabled: boolean;
  tp_pct: string | null;
  sl_pct: string | null;
  trail_activate_pct: string | null;
  trail_callback_pct: string | null;
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
  tpsl?: TPSL;
  /** copy = trade; watch = push the source's signals only ("观察模式"). */
  mode?: "copy" | "watch";
  watch?: WatchRules;
}
/** Which source signals a watch-only task pushes; adds / reduces below min_notional are not. */
export interface WatchRules {
  open: boolean;
  add: boolean;
  reduce: boolean;
  close: boolean;
  min_notional: string;
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
  /** Loss limits in USDT or in percent of the task's capital. */
  loss_unit?: "usdt" | "pct";
  max_positions?: number | null;
  profit_target?: string | null;
  profit_action?: "pause" | "close";
  /** Source drawdown breaker: % of the source's equity below its peak cumulative PnL (null = off). */
  source_dd_pct?: string | null;
  source_dd_action?: "pause" | "close";
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

export interface PositionLive {
  connection_id: string;
  alias: string;
  base: string;
  symbol: string;
  /** Signed coins, positive = long. */
  size: string;
  entry_px: string;
  mark_px: string;
  leverage: string | null;
  notional: string;
  margin: string | null;
  upnl: string;
  pnl_pct: string | null;
  roe_pct: string | null;
  src_size?: string | null;
  src_entry_px?: string | null;
  src_leverage?: string | null;
}

export interface OverviewPosition extends PositionLive {
  platform: Platform;
  testnet: boolean;
  tasks: { id: string; name: string }[];
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
  /** Follower positions in the coins this task manages (absent from older servers). */
  positions?: PositionLive[];
  paused: boolean;
  /** Source drawdown breaker: current drawdown (%) from the peak PnL. */
  source_dd_pct?: string | null;
  source_peak_pnl?: string | null;
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
  /** Allocated capital, else the accounts' equity at start (ROI base). */
  capital?: string | null;
  live: TaskLive | null;
  week_adds: number;
  week_reduces: number;
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

export interface CostTotals {
  fees: number;
  taker_fees: number;
  funding: number;
  funding_in: number;
  funding_out: number;
  fills: number;
  taker_fills: number;
}

export interface TaskPnlParts {
  realized: string;
  upnl: string;
  gross: string;
  /** Paid (negative = rebates). */
  fees: string;
  /** Received (negative = paid). */
  funding: string;
  net: string;
  costs: CostTotals;
}

export type FillDir = "open_long" | "close_long" | "open_short" | "close_short" | "flip_long" | "flip_short";
export interface CostRow {
  id: number;
  task_id: string;
  connection_id: string;
  alias: string;
  base: string;
  ts: number;
  kind: "fee" | "funding";
  /** Fee: paid (positive); funding: received (positive) or paid. */
  amount: string;
  rate: string | null;
  qty: string | null;
  px: string | null;
  maker: boolean | null;
  dir: FillDir | null;
  order_id: number | null;
  purpose: string | null;
  reason: string | null;
}
export interface CostPage {
  rows: CostRow[];
  totals: CostTotals;
  count: number;
  kinds: Partial<Record<"fee" | "funding", number>>;
}

export interface TaskDetail extends TaskSummary {
  /** PnL split into its parts (null before the task traded). */
  pnl: TaskPnlParts | null;
  latency_p95: number | null;
  mirrors: Mirror[];
  signals: SignalWithOrders[];
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ChartFill {
  id: number;
  signal_id: number | null;
  ts: number;
  connection_id: string | null;
  buy: boolean;
  qty: string;
  px: string;
  ref_px: string | null;
  slippage_bps: string | null;
  latency_ms: number | null;
  reduce_only: boolean;
  purpose: string;
}

export type ChartInterval = "15m" | "1h" | "4h" | "1d";

export interface TaskChart {
  base: string;
  interval: ChartInterval;
  bases: string[];
  candles: Candle[];
  candle_error: string | null;
  fills: ChartFill[];
}

export type PnlRange = "today" | "7d" | "30d" | "all";

export interface TaskPnl {
  task_id: string;
  name: string;
  status: TaskSummary["status"];
  pause_reason: string | null;
  pnl: number;
  start_equity: number;
  /** Last 14 days, oldest first: [day start ms, pnl]. */
  daily: [number, number][];
}

export interface PnlCurve {
  range: PnlRange;
  since: number;
  points: [number, number][];
  start_equity: number;
  tasks: TaskPnl[];
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
  /** Open positions on follower accounts (absent from older servers). */
  positions?: OverviewPosition[];
  tasks: TaskSummary[];
  alerts: Alert[];
  today: { signals: number; orders: number; avg_slippage_pct: string | null; skipped: number; failed: number };
  estopped: boolean;
}

export interface Preview {
  source_equity: string;
  sample_base: string | null;
  source_positions: number;
  rows: {
    connection_id: string;
    alias: string;
    equity: string;
    available: string;
    ratio_pct: string | null;
    sample_target: string | null;
    sync_notional: string;
    capital?: string | null;
    other_capital?: string | null;
  }[];
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
  /** Position history and costs; 0 = keep forever. */
  trip_retention_days?: number;
  /** Operation audit log; 0 = keep forever. */
  audit_retention_days?: number;
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

export type TripReason = "sync" | "reconcile" | "close" | "tp" | "sl" | "trail" | "mirror" | "account" | "release" | "close_all";
export interface Trip {
  id: number;
  task_id: string;
  connection_id: string;
  alias: string;
  base: string;
  side: "long" | "short";
  opened_at: number;
  closed_at: number;
  max_size: string;
  max_notional: string;
  entry_px: string;
  exit_px: string;
  realized: string;
  leverage: string | null;
  roe_pct: string | null;
  hold_ms: number;
  reason: TripReason;
  note: string | null;
  fees?: string;
  funding?: string;
  /** Realised less fees plus funding. */
  net?: string;
}
export interface TripStats {
  count: number;
  wins: number;
  losses: number;
  win_rate: string | null;
  profit_factor: string | null;
  avg_win: string | null;
  avg_loss: string | null;
  avg_hold_ms: number | null;
  realized: string;
  fees?: string;
  funding?: string;
  net?: string;
  reasons: Partial<Record<TripReason, number>>;
}
export interface TripPage {
  rows: Trip[];
  total: number;
  stats: TripStats;
}

export interface SimResult {
  window: "7d" | "30d";
  from: number;
  to: number;
  capital: number;
  slip_bps: number;
  pnl: number;
  roi: number;
  trader_roi: number;
  efficiency: number | null;
  max_dd: number;
  trades: number;
  skipped: number;
  considered: number;
  fees: number;
  slip_cost: number;
  start?: SimStart;
  ignored: string[];
  /** Held when the window opened and bought in at the first price seen (sync_existing). */
  synced?: string[];
  /** Builder-dex (HIP-3) perps the engine cannot trade; left out of the replay. */
  unsupported: string[];
  coins: { coin: string; trades: number; pnl: number }[];
  /** [ts, simulated PnL, trader's PnL scaled to the capital] */
  curve: [number, number, number][];
  suggest_capital: number | null;
  truncated: boolean;
}

export type SimStart = "new_only" | "sync_existing";

export type WebhookFormat = "generic" | "feishu" | "dingtalk" | "wecom" | "discord" | "slack";
export interface NotifyConfig {
  telegram: { enabled: boolean; token: string; chat_id: string };
  webhook: { enabled: boolean; format: WebhookFormat; url: string };
  events: { error: boolean; risk: boolean; lifecycle: boolean; trade: boolean; signal?: boolean };
  daily: { enabled: boolean; at: string };
  heartbeat: { enabled: boolean; url: string; interval_secs: number };
}
export interface ChannelStatus {
  last_at: number | null;
  last_ok: boolean;
  last_error: string | null;
  last_ms: number | null;
  last_code: number | null;
}
export interface NotifyState {
  /** Secrets come back empty; an empty field on save keeps the stored value. */
  config: NotifyConfig;
  hints: { telegram_token: string | null; webhook_url: string | null; heartbeat_url: string | null };
  status: { telegram: ChannelStatus; webhook: ChannelStatus; heartbeat: ChannelStatus; daily_last: string | null };
  formats: WebhookFormat[];
  /** False while the secrets file is locked (tokens unavailable, settings read-only). */
  secrets_available?: boolean;
}

export interface TotpStatus {
  enabled: boolean;
  recovery_left: number;
  secrets_locked: boolean;
  pending: boolean;
  sensitive: string[];
}
export interface TotpSetup {
  secret: string;
  uri: string;
  qr_svg: string;
}

export interface OpLogRow {
  id: number;
  ts: number;
  command: string;
  summary: string | null;
  ok: boolean;
  error: string | null;
  ip: string | null;
  ua: string | null;
  otp: boolean;
  sensitive: boolean;
}
export interface OpLogFilter {
  since?: number;
  until?: number;
  sensitive?: boolean;
  failed?: boolean;
  query?: string;
  limit?: number;
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
  addSource: (input: { kind: Source["kind"]; name: string; connection_id?: string | null; address?: string | null; testnet?: boolean }) => invoke<string>("add_source", { input }),
  deleteSource: (id: string) => invoke<void>("delete_source", { id }),
  sourceDetail: (id: string) => invoke<SourceDetail>("source_detail", { id }),
  plaza: () => invoke<PlazaList>("plaza_list"),
  plazaWallet: (address: string) => invoke<PlazaWalletDetail>("plaza_wallet", { address }),
  plazaFavorite: (address: string, on: boolean) => invoke<void>("plaza_favorite", { address, on }),
  paperTrade: (input: { connection_id: string; base: string; action: "open" | "close" | "cancel"; buy?: boolean; notional?: string | null; price?: string | null; leverage?: number | null; order_id?: string | null }) =>
    invoke<void>("paper_trade", { input }),

  tasks: () => invoke<TaskSummary[]>("list_tasks"),
  task: (id: string) => invoke<TaskDetail>("get_task", { id }),
  createTask: (input: TaskInput) => invoke<string>("create_task", { input }),
  updateTask: (id: string, update: { name?: string; rules?: Rules; risk?: Risk; followers?: FollowerSpec[] }) => invoke<void>("update_task", { id, update }),
  taskAction: (id: string, action: "start" | "resume" | "pause" | "stop" | "reconcile", closePositions?: boolean) =>
    invoke<void>("task_action", { id, action, close_positions: closePositions ?? null }),
  deleteTask: (id: string) => invoke<void>("delete_task", { id }),
  preview: (input: { source_id: string; followers: FollowerSpec[]; rules: Rules; task_id?: string | null }) => invoke<Preview>("preview_task", { input }),
  positionHistory: (args: { id: string; connectionId?: string | null; since?: number | null; limit?: number; offset?: number }) =>
    invoke<TripPage>("task_position_history", { id: args.id, connection_id: args.connectionId ?? null, since: args.since ?? null, limit: args.limit ?? 50, offset: args.offset ?? 0 }),
  taskCosts: (args: { id: string; kind?: "fee" | "funding" | null; connectionId?: string | null; since?: number | null; limit?: number }) =>
    invoke<CostPage>("task_costs", { id: args.id, kind: args.kind ?? null, connection_id: args.connectionId ?? null, since: args.since ?? null, limit: args.limit ?? 200 }),
  plazaSimulate: (args: { address: string; window: "7d" | "30d"; capital: number; slipBps: number; start?: SimStart }) =>
    invoke<SimResult>("plaza_simulate", { address: args.address, window: args.window, capital: args.capital, slip_bps: args.slipBps, start: args.start ?? "new_only" }),
  notify: () => invoke<NotifyState>("get_notify"),
  setNotify: (config: NotifyConfig) => invoke<NotifyState>("set_notify", { config }),
  testNotify: (channel: "telegram" | "webhook" | "heartbeat" | "report", config: NotifyConfig) => invoke<{ ms: number }>("test_notify", { channel, config }),

  overview: () => invoke<Overview>("get_overview"),
  alerts: (limit = 50) => invoke<Alert[]>("list_alerts", { limit }),
  logs: (filter: LogFilter) => invoke<LogPage>("query_logs", { filter }),
  exportCsv: (filter: LogFilter) => invoke<{ csv: string; rows: number }>("export_logs_csv", { filter }),
  /** Per-signal source vs. follower deviations (time, position share, price, return) as CSV. */
  exportTaskAudit: (taskId: string, range: LogFilter["range"]) => invoke<{ csv: string; rows: number; name: string }>("export_task_audit", { task_id: taskId, range }),
  pnl: (range: LogFilter["range"]) => invoke<PnlRow[]>("pnl_report", { range }),
  taskChart: (args: { taskId: string; base?: string; interval: ChartInterval; connectionId?: string }) =>
    invoke<TaskChart>("task_chart", { task_id: args.taskId, base: args.base ?? "", interval: args.interval, connection_id: args.connectionId ?? null }),
  pnlCurve: (range: PnlRange) => invoke<PnlCurve>("pnl_curve", { range }),
  equitySeries: (args: { connectionId?: string; sourceId?: string; since?: number }) =>
    invoke<[number, string][]>("equity_series", { connection_id: args.connectionId ?? null, source_id: args.sourceId ?? null, since: args.since ?? null }),

  settings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<Settings>("set_settings", { settings }),
  setLockPassword: (password: string | null) => invoke<void>("set_lock_password", { password }),
  lock: () => invoke<boolean>("lock_app"),
  unlock: (password: string, otp?: string) => invoke<void>("unlock_app", { password, otp: otp ?? "" }),
  unlockSecrets: (password: string) => invoke<void>("unlock_secrets", { password }),
  symbolMap: (query?: string) => invoke<SymbolRow[]>("symbol_map", { query: query ?? null }),
  setSymbolOverride: (base: string, platform: Platform, symbol: string | null, disabled: boolean, clear = false) =>
    invoke<void>("set_symbol_override", { base, platform, symbol, disabled, clear }),
  regenerateSymbols: () => invoke<void>("regenerate_symbol_map"),
  symbolsUpdatedAt: () => invoke<number | null>("symbols_updated_at"),
  exportConfig: () => invoke<unknown>("export_config"),
  importConfig: (config: unknown) => invoke<string>("import_config", { config }),

  totpStatus: () => invoke<TotpStatus>("totp_status"),
  totpSetup: () => invoke<TotpSetup>("totp_setup"),
  totpEnable: (code: string) => invoke<{ recovery_codes: string[] }>("totp_enable", { code }),
  totpDisable: () => invoke<void>("totp_disable"),
  totpRecoveryRegen: () => invoke<{ recovery_codes: string[] }>("totp_recovery_regen"),
  opLog: (filter: OpLogFilter) => invoke<OpLogRow[]>("list_op_log", { ...filter }),
};

export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
