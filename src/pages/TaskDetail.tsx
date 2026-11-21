import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Download, Eye, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { PositionsTable } from "../components/Positions";
import { fillLabel, TaskChart } from "../components/TaskChart";
import { Button, Drawer, Empty, Loading, Modal, Radio, Seg, SideTag, Tabs } from "../components/ui";
import { api, errMsg, type ChartInterval, type CostRow, type FillDir, type LogFilter, type CompareRow, type Mirror, type Risk, type TaskDetail as TD, type TaskSummary, type Trip, type TripStats } from "../lib/api";
import { downloadText } from "../lib/files";
import { ago, date, dur, num, pnlClass, price, qty, signed, time } from "../lib/format";
import { trNow, useTr } from "../lib/i18n";
import { useAction, useConnections, usePositionHistory, useTask, useTaskChart, useTaskCosts } from "../lib/queries";
import { replay, type ReplayedFill } from "../lib/replay";
import { useUi } from "../lib/store";
import { sourceLabel } from "./Overview";
import { sizingLabel, WatchTag } from "./Tasks";

export function TaskDetail() {
  const tr = useTr();
  const { route, go, goTo } = useUi();
  const { data: t, isLoading } = useTask(route.id);
  const [tab, setTab] = useState<"hold" | "trips" | "costs" | "pos" | "mirror" | "log">("hold");
  const [stopping, setStopping] = useState(false);
  const [rules, setRules] = useState(false);
  const [exporting, setExporting] = useState(false);
  const act = useAction(({ a }: { a: "start" | "resume" | "pause" | "reconcile" }) => api.taskAction(route.id!, a), { invalidate: [["task"], ["tasks"]] });
  // All-time round-trip stats for the hero and the tab count.
  const { data: tripsAll } = usePositionHistory({ id: route.id, limit: 0 });

  if (isLoading || !t) return <Loading />;
  const live = t.live;
  const liveMirrors = t.mirrors.filter((m) => m.status !== "done");
  const watching = t.rules.mode === "watch";
  const convert = () => goTo({ page: "wizard", id: t.id, convert: true });

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-4 py-4 max-lg:pb-20 md:px-6 md:py-6">
        <div className="flex items-center gap-2 text-xs text-muted-fg max-md:hidden">
          <button className="hover:text-fg" onClick={() => go("tasks")}>
            {tr("跟单任务", "Tasks")}
          </button>
          <span>/</span>
          <span className="text-fg">{t.name}</span>
        </div>
        <div className="flex items-center justify-between gap-4 md:mt-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-3xl font-semibold tracking-[-1px] max-md:hidden">{t.name}</h1>
            <StatusPill t={t} />
            <WatchTag t={t} />
            <span className="truncate text-xs text-muted-fg md:hidden">
              {sourceLabel(t)} {watching ? tr("· 只观察提醒", "· watch only") : <>→ {t.followers.length} {tr("个账户", "accounts")}</>}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2 max-lg:hidden">
            {t.status === "running" ? (
              <Button onClick={() => act.mutate({ a: "pause" })}>{tr("暂停任务", "Pause")}</Button>
            ) : (
              <Button variant="primary" onClick={() => act.mutate({ a: t.started_at && t.status === "paused" ? "resume" : "start" })}>
                {t.status === "stopped" ? tr("重新启动", "Restart") : t.started_at ? tr("恢复任务", "Resume") : tr("启动任务", "Start")}
              </Button>
            )}
            {watching ? (
              <Button variant="primary" onClick={convert}>
                {tr("转为跟单", "Convert to copy")}
              </Button>
            ) : (
              <>
                <Button disabled={t.status !== "running"} onClick={() => act.mutate({ a: "reconcile" })}>
                  <RefreshCw size={14} />
                  {tr("立即对账", "Reconcile now")}
                </Button>
                <Button onClick={() => setExporting(true)}>
                  <Download size={14} />
                  {tr("导出偏差数据", "Export deviations")}
                </Button>
              </>
            )}
            {t.status !== "stopped" ? (
              <Button variant="danger-text" onClick={() => setStopping(true)}>
                {tr("停止任务…", "Stop…")}
              </Button>
            ) : null}
          </div>
        </div>
        {t.pause_reason && t.status === "paused" ? <div className="mt-2 text-xs text-warning">{t.pause_reason}</div> : null}
        {live?.last_error ? <div className="mt-2 text-xs text-danger">{live.last_error}</div> : null}
        {watching ? (
          <WatchView t={t} />
        ) : (
          <>
            <PnlHero t={t} stats={tripsAll?.stats} />
            <ChartCard t={t} />
            <CopyTabs t={t} tab={tab} setTab={setTab} trips={tripsAll?.total} mirrors={liveMirrors.length} />
          </>
        )}
      </div>
      <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-border px-6 py-6 max-lg:hidden">
        <RulesPanel t={t} />
      </aside>
      <Drawer open={rules} onClose={() => setRules(false)} title={tr("规则与风控", "Rules & risk")} width={380}>
        <RulesPanel t={t} />
      </Drawer>
      <div className="fixed inset-x-0 bottom-14 z-20 flex gap-2 border-t border-border bg-card px-4 py-2.5 md:bottom-0 md:left-[220px] lg:hidden">
        <Button onClick={() => setRules(true)}>
          <SlidersHorizontal size={14} />
          {tr("规则", "Rules")}
        </Button>
        {watching ? (
          <Button onClick={convert}>{tr("转为跟单", "Convert")}</Button>
        ) : (
          <>
            <Button disabled={t.status !== "running"} onClick={() => act.mutate({ a: "reconcile" })}>
              <RefreshCw size={14} />
              <span className="max-sm:hidden">{tr("对账", "Reconcile")}</span>
            </Button>
            <Button onClick={() => setExporting(true)} aria-label={tr("导出偏差数据", "Export deviations")}>
              <Download size={14} />
              <span className="max-sm:hidden">{tr("导出", "Export")}</span>
            </Button>
          </>
        )}
        {t.status !== "stopped" ? (
          <Button variant="danger-text" onClick={() => setStopping(true)}>
            {tr("停止", "Stop")}
          </Button>
        ) : null}
        {t.status === "running" ? (
          <Button variant="primary" className="flex-1" onClick={() => act.mutate({ a: "pause" })}>
            {watching ? tr("暂停观察", "Pause") : tr("暂停跟单", "Pause")}
          </Button>
        ) : (
          <Button variant="primary" className="flex-1" onClick={() => act.mutate({ a: t.started_at && t.status === "paused" ? "resume" : "start" })}>
            {t.status === "stopped" ? tr("重新启动", "Restart") : t.started_at ? (watching ? tr("恢复观察", "Resume") : tr("恢复跟单", "Resume")) : tr("启动", "Start")}
          </Button>
        )}
      </div>
      {stopping ? <StopDialog task={t} onClose={() => setStopping(false)} /> : null}
      {exporting ? <AuditExportDialog task={t} onClose={() => setExporting(false)} /> : null}
    </div>
  );
}

type TabKey = "hold" | "trips" | "costs" | "pos" | "mirror" | "log";

function CopyTabs({ t, tab, setTab, trips, mirrors }: { t: TD; tab: TabKey; setTab: (k: TabKey) => void; trips?: number; mirrors: number }) {
  const tr = useTr();
  const live = t.live;
  return (
    <>
      <Tabs
        className="mt-6"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "hold", label: `${tr("当前持仓", "Positions")} ${live?.positions?.length || ""}` },
          { value: "trips", label: `${tr("历史仓位", "History")} ${trips || ""}` },
          {
            value: "costs",
            label: (
              <>
                {tr("费用明细", "Fees & funding")}
                <span className="ml-1 rounded-sm bg-primary-soft px-1 text-[11px] font-semibold text-primary">{tr("新", "New")}</span>
              </>
            ),
          },
          { value: "pos", label: tr("仓位对比", "Source vs. follower") },
          { value: "mirror", label: `${tr("挂单镜像", "Mirrored orders")} ${mirrors || ""}` },
          { value: "log", label: tr("执行日志", "Execution log") },
        ]}
      />
      <div key={tab} className="anim-rise mt-4 shrink-0 overflow-x-auto max-md:[&_table]:min-w-[640px]">
        {tab === "hold" ? (
          <div className="border border-border bg-card">
            <PositionsTable
              kind="task"
              rows={live?.positions ?? []}
              empty={<Empty title={t.status === "running" ? tr("当前没有持仓", "No open positions") : tr("任务未运行", "Task not running")} hint={tr("跟单账户在本任务管理的品种上有仓位时，这里显示持仓均价、杠杆、保证金和浮动盈亏。", "Entry, leverage, margin and unrealized PnL appear here for coins this task manages.")} />}
            />
          </div>
        ) : null}
        {tab === "trips" ? <TripsTab t={t} /> : null}
        {tab === "costs" ? <CostsTab t={t} /> : null}
        {tab === "pos" ? <PositionCompare rows={live?.rows ?? []} running={t.status === "running"} tolerance={t.rules.tolerance_pct} /> : null}
        {tab === "mirror" ? <Mirrors mirrors={t.mirrors} enabled={t.rules.mirror.enabled} grace={t.rules.mirror.grace_ms} /> : null}
        {tab === "log" ? <SignalLog t={t} /> : null}
      </div>
    </>
  );
}

function StatusPill({ t }: { t: TaskSummary }) {
  const tr = useTr();
  const m = {
    running: ["bg-success-soft text-success", tr("运行中", "Running")],
    paused: ["bg-muted text-muted-fg", tr("已暂停", "Paused")],
    stopped: ["bg-muted text-muted-fg", tr("已停止", "Stopped")],
  }[t.status];
  return (
    <span className={clsx("inline-flex h-6 items-center gap-1.5 px-2 text-xs", m[0])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {m[1]}
    </span>
  );
}

function PnlHero({ t, stats }: { t: TD; stats?: TripStats }) {
  const tr = useTr();
  const lang = useUi((s) => s.lang);
  const en = lang === "en";
  const live = t.live;
  const p = t.pnl;
  const upnlLive = live?.followers.reduce((a, f) => a + Number(f.upnl || 0), 0);
  const net = p ? Number(p.net) : t.total_pnl != null ? Number(t.total_pnl) : null;
  const roi = t.capital && Number(t.capital) > 0 && net != null ? (net / Number(t.capital)) * 100 : null;
  const exits = (stats?.reasons.tp ?? 0) + (stats?.reasons.trail ?? 0);
  const fees = p ? Number(p.fees) : null;
  const funding = p ? Number(p.funding) : null;
  const gross = p ? Number(p.gross) : null;
  const c = p?.costs;
  const takerPct = c && c.fills ? (c.taker_fills / c.fills) * 100 : null;
  const costShare = gross != null && gross > 0 && fees != null && funding != null ? ((fees - funding) / gross) * 100 : null;
  const dd = live?.source_dd_pct != null ? Number(live.source_dd_pct) : null;
  const ddLimit = t.risk.source_dd_pct ? Number(t.risk.source_dd_pct) : null;
  return (
    <>
      <div className="mt-4 grid grid-cols-[minmax(220px,1.4fr)_repeat(4,minmax(0,1fr))] border border-border bg-card max-lg:grid-cols-4 max-md:-mx-4 max-md:grid-cols-2 max-md:border-x-0">
        <div className="border-r border-border px-4 py-4 max-lg:col-span-4 max-lg:border-r-0 max-lg:border-b max-md:col-span-2 md:px-5">
          <div className="text-xs text-muted-fg">{tr("净盈亏 USDT", "Net PnL USDT")}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={clsx("num text-[32px] leading-10 font-semibold tracking-[-0.5px]", pnlClass(net))}>{signed(net)}</span>
            {roi != null ? <span className={clsx("num text-sm", pnlClass(roi))}>{signed(roi, 1)}%</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-fg">
            <span>{tr("已扣手续费与资金费", "After fees and funding")}</span>
            <span>
              {tr("今日", "Today")} <span className={clsx("num", pnlClass(t.today_pnl))}>{signed(t.today_pnl)}</span>
            </span>
          </div>
        </div>
        <HeroCell
          label={tr("毛盈亏", "Gross PnL")}
          value={gross != null ? signed(gross) : upnlLive != null ? signed(upnlLive) : "—"}
          cls={pnlClass(gross ?? upnlLive)}
          sub={p ? tr(`已实现 ${signed(p.realized)}，浮动 ${signed(p.upnl)}`, `Realised ${signed(p.realized)}, open ${signed(p.upnl)}`) : undefined}
        />
        <HeroCell
          label={tr("手续费", "Fees")}
          value={fees != null ? signed(-fees) : "—"}
          cls={fees ? (fees > 0 ? "text-danger" : "text-success") : undefined}
          sub={c && c.fills ? tr(`${c.fills} 笔成交，吃单占 ${num(takerPct, 0)}%`, `${c.fills} fills, ${num(takerPct, 0)}% taker`) : tr("暂无成交", "No fills yet")}
        />
        <HeroCell
          label={tr("资金费", "Funding")}
          value={funding != null ? signed(funding) : "—"}
          cls={pnlClass(funding)}
          sub={c && (c.funding_in || c.funding_out) ? tr(`收入 ${signed(c.funding_in)}，支出 ${signed(-Math.abs(c.funding_out))}`, `In ${signed(c.funding_in)}, out ${signed(-Math.abs(c.funding_out))}`) : tr("暂无结算", "None settled yet")}
        />
        <HeroCell label={tr("费用占毛利", "Costs / gross")} value={costShare != null ? `${num(costShare, 1)}%` : "—"} cls={costShare != null && costShare > 30 ? "text-warning" : undefined} sub={tr("手续费减资金费后的净成本", "Fees less funding")} last />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-fg">
        <span>
          {tr("胜率", "Win rate")} <span className="num text-fg">{stats?.win_rate != null ? `${num(stats.win_rate, 1)}%` : "—"}</span>
          {stats && stats.count ? tr(`（盈 ${stats.wins} / 亏 ${stats.losses}）`, ` (${stats.wins} / ${stats.losses})`) : ""}
        </span>
        <span>
          {tr("盈亏比", "Profit factor")} <span className="num text-fg">{stats?.profit_factor != null ? num(stats.profit_factor, 2) : "—"}</span>
        </span>
        <span>
          {tr("平均持仓", "Avg hold")} <span className="text-fg">{dur(stats?.avg_hold_ms, en)}</span>
          {stats && (exits || stats.reasons.sl) ? tr(`（止盈 ${exits}，止损 ${stats.reasons.sl ?? 0}）`, ` (${exits} TP, ${stats.reasons.sl ?? 0} SL)`) : ""}
        </span>
        <span>
          {tr("名义偏差", "Notional gap")} <span className={clsx("num", live && Math.abs(Number(live.deviation_pct)) > Number(t.rules.tolerance_pct) ? "text-warning" : "text-fg")}>{live ? `${num(live.deviation_pct, 1)}%` : "—"}</span>
          {tr(`（容差 ${num(t.rules.tolerance_pct, 0)}%）`, ` (tolerance ${num(t.rules.tolerance_pct, 0)}%)`)}
        </span>
        {ddLimit ? (
          <span>
            {tr("信号源回撤", "Source drawdown")} <span className={clsx("num", dd != null && dd >= ddLimit * 0.8 ? "text-warning" : "text-fg")}>{dd != null ? `${num(dd, 1)}%` : "—"}</span>
            {tr(` / 熔断线 ${num(ddLimit, 1)}%`, ` / breaker ${num(ddLimit, 1)}%`)}
          </span>
        ) : null}
        <span>
          {tr("延迟 P95", "Latency P95")} <span className="num text-fg">{t.latency_p95 != null ? `${t.latency_p95} ms` : "—"}</span>
        </span>
        <span>
          {tr("上次对账", "Reconciled")} {ago(live?.last_reconcile, en)}
        </span>
      </div>
    </>
  );
}

const TRIP_WINDOWS = { "7d": 7, "30d": 30, all: 0 } as const;

function tripReason(tr: Trip): { label: string; cls: string } {
  const t = trNow;
  switch (tr.reason) {
    case "tp":
      return { label: t("止盈", "Take profit"), cls: "bg-success-soft text-success" };
    case "trail":
      return { label: t("移动止盈", "Trailing TP"), cls: "bg-success-soft text-success" };
    case "sl":
      return { label: t("止损", "Stop loss"), cls: "bg-danger-soft text-danger" };
    case "close":
      return { label: tr.note ? t(`风控：${tr.note.replace(/触发$/, "")}`, `Risk: ${tr.note}`) : t("风控平仓", "Risk close"), cls: "bg-primary-soft text-primary" };
    case "account":
      return { label: t("账户减仓 / 强平", "Account cut"), cls: "bg-danger-soft text-danger" };
    case "release":
      return { label: t("任务停止", "Task stopped"), cls: "bg-muted text-muted-fg" };
    case "close_all":
      return { label: t("全部平仓", "Close all"), cls: "bg-primary-soft text-primary" };
    case "mirror":
      return { label: t("挂单成交", "Mirrored order"), cls: "bg-muted text-muted-fg" };
    case "reconcile":
      return { label: t("对账修正", "Reconcile"), cls: "bg-muted text-muted-fg" };
    default:
      return { label: t("跟随信号源平仓", "Followed source"), cls: "bg-muted text-muted-fg" };
  }
}

function sideLabel(r: Trip) {
  const lev = r.leverage ? ` ${num(r.leverage, 0)}x` : "";
  return r.side === "long" ? trNow(`多${lev}`, `Long${lev}`) : trNow(`空${lev}`, `Short${lev}`);
}

function stamp(ts: number) {
  return `${date(ts)} ${time(ts).slice(0, 5)}`;
}

function TripsTab({ t }: { t: TD }) {
  const tr = useTr();
  const en = useUi((s) => s.lang) === "en";
  const toast = useUi((s) => s.toast);
  const [conn, setConn] = useState("");
  const [win, setWin] = useState<keyof typeof TRIP_WINDOWS>("30d");
  const [limit, setLimit] = useState(50);
  const [exporting, setExporting] = useState(false);
  // Snap the window start to the minute so the query key stays stable.
  const since = TRIP_WINDOWS[win] ? Math.floor((Date.now() - TRIP_WINDOWS[win] * 86_400_000) / 60_000) * 60_000 : null;
  const { data, isLoading } = usePositionHistory({ id: t.id, connectionId: conn || null, since, limit });
  const rows = data?.rows ?? [];

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await api.positionHistory({ id: t.id, connectionId: conn || null, since, limit: 5000 });
      const head = ["coin", "side", "leverage", "account", "opened_at", "closed_at", "hold_min", "max_size", "max_notional", "entry_px", "exit_px", "realized", "fees", "funding", "net", "roe_pct", "reason", "note"];
      const iso = (ms: number) => new Date(ms).toISOString();
      const esc = (v: string | number | null) => {
        const x = v == null ? "" : String(v);
        return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
      };
      const lines = all.rows.map((r) => [r.base, r.side, r.leverage, r.alias, iso(r.opened_at), iso(r.closed_at), Math.round(r.hold_ms / 60_000), r.max_size, r.max_notional, r.entry_px, r.exit_px, r.realized, r.fees ?? "0", r.funding ?? "0", r.net ?? r.realized, r.roe_pct, r.reason, r.note].map(esc).join(","));
      downloadText(`${t.name}-positions.csv`, [head.join(","), ...lines].join("\n"), "text/csv");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {t.followers.length > 1 ? (
          <Seg
            size="sm"
            value={conn}
            onChange={(v) => {
              setConn(v);
              setLimit(50);
            }}
            options={[{ value: "", label: tr("全部账户", "All accounts") }, ...t.followers.map((f) => ({ value: f.connection_id, label: f.alias }))]}
          />
        ) : null}
        <Seg
          size="sm"
          value={win}
          onChange={(v) => {
            setWin(v);
            setLimit(50);
          }}
          options={[
            { value: "7d", label: tr("7 天", "7d") },
            { value: "30d", label: tr("30 天", "30d") },
            { value: "all", label: tr("全部", "All") },
          ]}
        />
        <div className="flex-1" />
        <Button size="sm" loading={exporting} disabled={!data?.total} onClick={exportCsv}>
          <Download size={13} />
          {tr("导出 CSV", "Export CSV")}
        </Button>
      </div>
      {isLoading && !data ? (
        <div className="h-40 border border-border bg-card" />
      ) : !rows.length ? (
        <div className="border border-border bg-card">
          <Empty title={tr("还没有平掉的仓位", "No closed positions yet")} hint={tr("本任务的一笔仓位从开仓到全部平掉（或反手）后，会在这里记一笔，含持仓时长、均价、已实现盈亏与平仓原因。", "Each position the task opens and fully closes (or flips) is listed here with hold time, prices, realised PnL and why it closed.")} />
        </div>
      ) : (
        <>
          <div className="border border-border bg-card max-md:hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-fg">
                  <th className="px-4 py-2.5 text-left font-normal">{tr("币种", "Coin")}</th>
                  <th className="text-left font-normal">{tr("账户", "Account")}</th>
                  <th className="text-left font-normal">{tr("开仓 → 平仓", "Opened → closed")}</th>
                  <th className="text-right font-normal">{tr("最大仓位", "Max size")}</th>
                  <th className="text-right font-normal">{tr("开仓均价", "Entry")}</th>
                  <th className="text-right font-normal">{tr("平仓均价", "Exit")}</th>
                  <th className="text-right font-normal">{tr("已实现", "Realised")}</th>
                  <th className="text-right font-normal">{tr("手续费", "Fees")}</th>
                  <th className="text-right font-normal">{tr("资金费", "Funding")}</th>
                  <th className="text-right font-normal">{tr("净盈亏", "Net")}</th>
                  <th className="text-right font-normal">ROE</th>
                  <th className="px-4 text-left font-normal">{tr("平仓原因", "Closed by")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const why = tripReason(r);
                  return (
                    <tr key={r.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-2.5">
                        <div className="font-semibold">{r.base}</div>
                        <div className={clsx("text-xs", r.side === "long" ? "text-success" : "text-danger")}>{sideLabel(r)}</div>
                      </td>
                      <td className="text-xs">{r.alias || "—"}</td>
                      <td className="whitespace-nowrap">
                        <div className="num text-xs">
                          {stamp(r.opened_at)} → {date(r.opened_at) === date(r.closed_at) ? time(r.closed_at).slice(0, 5) : stamp(r.closed_at)}
                        </div>
                        <div className="text-xs text-muted-fg">
                          {tr("持仓", "Held")} {dur(r.hold_ms, en)}
                        </div>
                      </td>
                      <td className="text-right">
                        <div className="num">{qty(r.max_size)}</div>
                        <div className="num text-xs text-muted-fg">≈ {num(r.max_notional, 0)}</div>
                      </td>
                      <td className="num text-right">{price(r.entry_px)}</td>
                      <td className="num text-right">{price(r.exit_px)}</td>
                      <td className={clsx("num text-right", pnlClass(r.realized))}>{signed(r.realized)}</td>
                      <td className="num text-right text-muted-fg">{Number(r.fees ?? 0) ? signed(-Number(r.fees)) : "—"}</td>
                      <td className={clsx("num text-right", Number(r.funding ?? 0) ? pnlClass(r.funding) : "text-muted-fg")}>{Number(r.funding ?? 0) ? signed(r.funding) : "—"}</td>
                      <td className={clsx("num text-right font-semibold", pnlClass(r.net ?? r.realized))}>{signed(r.net ?? r.realized)}</td>
                      <td className={clsx("num text-right", pnlClass(r.roe_pct))}>{r.roe_pct != null ? `${signed(r.roe_pct, 1)}%` : "—"}</td>
                      <td className="px-4">
                        <span className={clsx("inline-flex h-6 items-center px-2 text-xs whitespace-nowrap", why.cls)} title={r.note ?? undefined}>
                          {why.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-2 md:hidden">
            {rows.map((r) => {
              const why = tripReason(r);
              return (
                <div key={r.id} className="border border-border bg-card px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="font-semibold">{r.base}</span>
                      <span className={clsx("text-xs", r.side === "long" ? "text-success" : "text-danger")}>{sideLabel(r)}</span>
                      <span className={clsx("inline-flex h-5 items-center px-1.5 text-[11px] whitespace-nowrap", why.cls)}>{why.label}</span>
                    </div>
                    <span className={clsx("num shrink-0 font-semibold", pnlClass(r.net ?? r.realized))}>{signed(r.net ?? r.realized)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-fg">
                    <span className="truncate">{tr(`${r.alias}，${stamp(r.opened_at)} 起持仓 ${dur(r.hold_ms)}`, `${r.alias}, from ${stamp(r.opened_at)}, held ${dur(r.hold_ms, true)}`)}</span>
                    <span className={clsx("num shrink-0", pnlClass(r.roe_pct))}>{r.roe_pct != null ? `${signed(r.roe_pct, 1)}%` : ""}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-fg">
            <span>{tr(`显示 ${rows.length} / ${data?.total ?? 0} 笔 · 按平仓时间倒序 · 净盈亏 = 已实现 − 手续费 + 资金费，ROE 按净盈亏计算`, `${rows.length} of ${data?.total ?? 0}, latest close first · Net = realised − fees + funding; ROE uses net`)}</span>
            {data && rows.length < data.total ? (
              <Button size="sm" onClick={() => setLimit((l) => l + 50)}>
                {tr(`加载更多（还有 ${data.total - rows.length} 笔）`, `Load more (${data.total - rows.length} left)`)}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

const DIR_LABEL: Record<FillDir, [string, string]> = {
  open_long: ["开多", "Open long"],
  close_long: ["平多", "Close long"],
  open_short: ["开空", "Open short"],
  close_short: ["平空", "Close short"],
  flip_long: ["反手多", "Flip long"],
  flip_short: ["反手空", "Flip short"],
};

const PURPOSE_LABEL: Record<string, [string, string]> = {
  sync: ["跟随信号源", "Followed source"],
  reconcile: ["对账补单", "Reconcile"],
  mirror: ["挂单镜像成交", "Mirrored order"],
  close: ["风控平仓", "Risk close"],
  tpsl: ["单仓止盈止损", "Per-position TP / SL"],
};

const pctStr = (rate: string | null, dp: number, sign = false) => {
  if (rate == null) return "—";
  const v = Number(rate) * 100;
  return `${sign && v > 0 ? "+" : ""}${v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)}%`;
};

function costLines(r: CostRow, paper: boolean) {
  const t = trNow;
  if (r.kind === "fee") {
    const d = r.dir ? DIR_LABEL[r.dir] : null;
    const what = `${d ? t(d[0], d[1]) : ""} ${qty(r.qty)} @ ${price(r.px)}`.trim();
    const rate = r.rate != null ? `${r.maker ? t("挂单", "Maker") : t("吃单", "Taker")} ${pctStr(r.rate, 3)}` : "—";
    const p = r.purpose ? PURPOSE_LABEL[r.purpose] : null;
    let why = p ? t(p[0], p[1]) : "";
    if (r.purpose === "sync" && r.dir?.startsWith("close")) why = t("跟随信号源平仓", "Followed source close");
    if (r.reason && (r.purpose === "tpsl" || r.purpose === "close")) why = r.reason;
    return { what, rate, why, amount: -Number(r.amount) };
  }
  const size = Number(r.qty ?? 0);
  const amount = Number(r.amount);
  const notional = r.rate && Number(r.rate) ? Math.abs(amount / Number(r.rate)) : null;
  const what = `${size > 0 ? t("多", "Long") : t("空", "Short")} ${qty(Math.abs(size))}${notional != null ? ` ≈ ${num(notional, 0)}` : ""}`;
  const rate = r.rate != null ? `${pctStr(r.rate, 4, true)} / 1h` : "—";
  const side = size > 0 ? t("多头", "longs") : t("空头", "shorts");
  const why = paper ? t("模拟账户按 HL 实时费率计息", "Paper account, accrued at HL's live rate") : amount >= 0 ? t(`每小时结算，${side}收取`, `Hourly, ${side} receive`) : t(`每小时结算，${side}支付`, `Hourly, ${side} pay`);
  return { what, rate, why, amount };
}

function CostsTab({ t }: { t: TD }) {
  const tr = useTr();
  const toast = useUi((s) => s.toast);
  const [kind, setKind] = useState<"" | "fee" | "funding">("");
  const [conn, setConn] = useState("");
  const [limit, setLimit] = useState(100);
  const [exporting, setExporting] = useState(false);
  const { data, isLoading } = useTaskCosts({ id: t.id, kind: kind || null, connectionId: conn || null, limit });
  const { data: conns } = useConnections();
  const paper = (id: string) => conns?.find((c) => c.id === id)?.platform === "paper";
  const rows = data?.rows ?? [];
  const k = data?.kinds ?? {};
  const all = (k.fee ?? 0) + (k.funding ?? 0);
  const stamp2 = (ts: number) => `${date(ts)} ${time(ts)}`;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const page = await api.taskCosts({ id: t.id, kind: kind || null, connectionId: conn || null, limit: 20000 });
      const head = ["time", "kind", "coin", "account", "dir", "qty", "px", "rate", "maker", "amount", "purpose", "reason"];
      const esc = (v: string | number | boolean | null) => {
        const x = v == null ? "" : String(v);
        return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
      };
      // Amount in the account's favour: fees negative, funding as settled.
      const lines = page.rows.map((r) => [new Date(r.ts).toISOString(), r.kind, r.base, r.alias, r.dir, r.qty, r.px, r.rate, r.maker, r.kind === "fee" ? String(-Number(r.amount)) : r.amount, r.purpose, r.reason].map(esc).join(","));
      downloadText(`${t.name}-costs.csv`, [head.join(","), ...lines].join("\n"), "text/csv");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Seg
          size="sm"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setLimit(100);
          }}
          options={[
            { value: "", label: tr(`全部 ${all}`, `All ${all}`) },
            { value: "fee", label: tr(`手续费 ${k.fee ?? 0}`, `Fees ${k.fee ?? 0}`) },
            { value: "funding", label: tr(`资金费 ${k.funding ?? 0}`, `Funding ${k.funding ?? 0}`) },
          ]}
        />
        {t.followers.length > 1 ? (
          <Seg
            size="sm"
            value={conn}
            onChange={(v) => {
              setConn(v);
              setLimit(100);
            }}
            options={[{ value: "", label: tr("全部账户", "All accounts") }, ...t.followers.map((f) => ({ value: f.connection_id, label: f.alias }))]}
          />
        ) : null}
        <div className="flex-1" />
        <Button size="sm" loading={exporting} disabled={!data?.count} onClick={exportCsv}>
          <Download size={13} />
          {tr("导出 CSV", "Export CSV")}
        </Button>
      </div>
      {isLoading && !data ? (
        <div className="h-40 border border-border bg-card" />
      ) : !rows.length ? (
        <div className="border border-border bg-card">
          <Empty title={tr("还没有费用记录", "No fees or funding yet")} hint={tr("跟单成交后约一分钟内，这里会列出每笔成交的手续费；持仓跨过整点时记一笔资金费。", "About a minute after each fill its fee appears here; holding through the hour books a funding payment.")} />
        </div>
      ) : (
        <>
          <div className="border border-border bg-card max-md:hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-fg">
                  <th className="px-4 py-2.5 text-left font-normal">{tr("时间", "Time")}</th>
                  <th className="text-left font-normal">{tr("类型", "Type")}</th>
                  <th className="text-left font-normal">{tr("币种", "Coin")}</th>
                  <th className="text-left font-normal">{tr("账户", "Account")}</th>
                  <th className="text-left font-normal">{tr("成交 / 计息仓位", "Fill / position")}</th>
                  <th className="text-left font-normal">{tr("费率", "Rate")}</th>
                  <th className="text-right font-normal">{tr("金额 USDT", "Amount USDT")}</th>
                  <th className="px-4 text-left font-normal">{tr("关联", "Related")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const l = costLines(r, paper(r.connection_id));
                  return (
                    <tr key={r.id} className="border-b border-border last:border-b-0">
                      <td className="num px-4 py-2.5 text-xs whitespace-nowrap text-muted-fg">{stamp2(r.ts)}</td>
                      <td>
                        <span className={clsx("inline-flex h-6 items-center px-2 text-xs whitespace-nowrap", r.kind === "fee" ? "bg-muted text-muted-fg" : "bg-primary-soft text-primary")}>{r.kind === "fee" ? tr("手续费", "Fee") : tr("资金费", "Funding")}</span>
                      </td>
                      <td className="font-semibold">{r.base}</td>
                      <td className="text-xs">{r.alias || "—"}</td>
                      <td className="num text-xs">{l.what}</td>
                      <td className="num text-xs text-muted-fg">{l.rate}</td>
                      <td className={clsx("num text-right", pnlClass(l.amount))}>{signed(l.amount)}</td>
                      <td className="px-4 text-xs text-muted-fg">{l.why || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-2 md:hidden">
            {rows.map((r) => {
              const l = costLines(r, paper(r.connection_id));
              return (
                <div key={r.id} className="border border-border bg-card px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="font-semibold">{r.base}</span>
                      <span className={clsx("inline-flex h-5 items-center px-1.5 text-[11px]", r.kind === "fee" ? "bg-muted text-muted-fg" : "bg-primary-soft text-primary")}>{r.kind === "fee" ? tr("手续费", "Fee") : tr("资金费", "Funding")}</span>
                      <span className="num truncate text-xs text-muted-fg">{l.what}</span>
                    </div>
                    <span className={clsx("num shrink-0 font-semibold", pnlClass(l.amount))}>{signed(l.amount)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-fg">
                    <span className="truncate">
                      {[stamp2(r.ts), r.alias, l.why].filter(Boolean).join(" · ")}
                    </span>
                    <span className="num shrink-0">{l.rate}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-fg">
            <span>{tr("手续费取自交易所成交回报，资金费按每小时结算记录；多个任务共用一个账户时按各任务持仓占比分摊", "Fees come from the venue's fill reports and funding from its hourly settlements; on a shared account funding is split by each task's share")}</span>
            {data && rows.length < data.count ? (
              <Button size="sm" onClick={() => setLimit((l) => l + 100)}>
                {tr(`加载更多（还有 ${data.count - rows.length} 条）`, `Load more (${data.count - rows.length} left)`)}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** A watch-only task: the source's signals and positions, no orders. */
function WatchView({ t }: { t: TD }) {
  const tr = useTr();
  const en = useUi((s) => s.lang) === "en";
  const [tab, setTab] = useState<"signals" | "positions">("signals");
  const src = useQuery({ queryKey: ["source-detail", t.source_id], queryFn: () => api.sourceDetail(t.source_id), refetchInterval: 15_000, retry: 0 });
  const live = t.live;
  const day = Date.now() - 86_400_000;
  const sigs = t.signals.filter((s) => s.kind !== "risk");
  const today = sigs.filter((s) => s.ts >= day).length;
  const w = t.rules.watch;
  const kinds = w ? [w.open && tr("开仓", "opens"), w.add && tr("加仓", "adds"), w.reduce && tr("减仓", "reductions"), w.close && tr("平仓与反手", "closes")].filter(Boolean).join(en ? ", " : "、") : "";
  const ps = (src.data?.positions ?? []).filter((p) => Number(p.size) !== 0);
  const eq = Number(live?.source_equity ?? src.data?.equity ?? 0);
  const notional = Number(live?.source_notional ?? src.data?.notional ?? 0);
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md bg-primary-soft px-4 py-3 text-sm">
        <Eye size={16} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          {tr("观察任务：不下单、不占本金。信号源仓位变化记录在下方，并按设置推送", "Watch task: no orders, no capital. The source's position changes are listed below and pushed by your filters")}
          {kinds ? tr(`（${kinds}）。`, ` (${kinds}).`) : en ? "." : "。"}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-4 border border-border bg-card max-md:-mx-4 max-md:grid-cols-2 max-md:border-x-0">
        <HeroCell label={tr("信号源权益", "Source equity")} value={eq > 0 ? num(eq, 0) : "—"} sub={live?.source_connected === false ? tr("信号源未连接", "Source offline") : "USDT"} />
        <HeroCell label={tr("信号源名义仓位", "Source notional")} value={notional ? num(notional, 0) : "—"} sub={tr(`${ps.length} 个持仓`, `${ps.length} positions`)} />
        <HeroCell label={tr("近 24 小时信号", "Signals, 24h")} value={String(today)} sub={tr(`共记录 ${sigs.length} 条`, `${sigs.length} recorded`)} />
        <HeroCell label={tr("最近信号", "Last signal")} value={sigs[0] ? ago(sigs[0].ts, en) : "—"} sub={w && Number(w.min_notional) > 0 ? tr(`加减仓 ≥ ${num(w.min_notional, 0)} USDT 才推送`, `Adds / trims ≥ ${num(w.min_notional, 0)} USDT pushed`) : tr("所有勾选的信号都推送", "All picked signals pushed")} last />
      </div>
      <Tabs
        className="mt-6"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "signals", label: `${tr("信号", "Signals")} ${sigs.length || ""}` },
          { value: "positions", label: `${tr("信号源持仓", "Source positions")} ${ps.length || ""}` },
        ]}
      />
      <div key={tab} className="anim-rise mt-4 shrink-0 overflow-x-auto">
        {tab === "signals" ? (
          <SignalLog t={t} />
        ) : src.error ? (
          <div className="text-xs text-danger">{errMsg(src.error)}</div>
        ) : !ps.length ? (
          <div className="border border-border bg-card">
            <Empty title={src.isLoading ? tr("正在读取…", "Loading…") : tr("信号源当前没有持仓", "The source holds nothing")} />
          </div>
        ) : (
          <div className="border border-border bg-card">
            <table className="w-full text-sm max-md:min-w-[560px]">
              <thead>
                <tr className="border-b border-border text-xs text-muted-fg">
                  <th className="px-4 py-2.5 text-left font-normal">{tr("币种", "Coin")}</th>
                  <th className="text-right font-normal">{tr("数量", "Size")}</th>
                  <th className="text-right font-normal">{tr("开仓均价", "Entry")}</th>
                  <th className="text-right font-normal">{tr("标记价", "Mark")}</th>
                  <th className="text-right font-normal">{tr("名义", "Notional")}</th>
                  <th className="px-4 text-right font-normal">{tr("浮动盈亏", "Unrealised")}</th>
                </tr>
              </thead>
              <tbody>
                {ps.map((p) => (
                  <tr key={p.symbol} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5">
                      <span className="font-semibold">{p.base}</span>
                      <span className={clsx("ml-2 text-xs", Number(p.size) > 0 ? "text-success" : "text-danger")}>
                        {Number(p.size) > 0 ? tr("多", "Long") : tr("空", "Short")}
                        {p.leverage ? ` ${num(p.leverage, 0)}x` : ""}
                      </span>
                    </td>
                    <td className="num text-right">{qty(Math.abs(Number(p.size)))}</td>
                    <td className="num text-right">{price(p.entry_px)}</td>
                    <td className="num text-right">{price(p.mark_px)}</td>
                    <td className="num text-right">{num(Math.abs(Number(p.size)) * Number(p.mark_px), 0)}</td>
                    <td className={clsx("num px-4 text-right", pnlClass(p.upnl))}>{signed(p.upnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function HeroCell({ label, value, cls, sub, last }: { label: string; value: string; cls?: string; sub?: string; last?: boolean }) {
  return (
    <div className={clsx("min-w-0 px-4 py-3 md:px-5 md:py-4", !last && "border-r border-border")}>
      <div className="truncate text-xs text-muted-fg">{label}</div>
      <div className={clsx("num mt-1 truncate text-lg md:text-xl", cls)}>{value}</div>
      {sub ? <div className="mt-1 line-clamp-2 text-xs text-muted-fg">{sub}</div> : null}
    </div>
  );
}

const INTERVALS: ChartInterval[] = ["15m", "1h", "4h", "1d"];
const INTERVAL_KEY = "merchandiser.chartInterval";

/** The last K-line timeframe picked on this device. */
function savedInterval(): ChartInterval {
  try {
    const v = localStorage.getItem(INTERVAL_KEY) as ChartInterval | null;
    if (v && INTERVALS.includes(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return "4h";
}

function ChartCard({ t }: { t: TD }) {
  const tr = useTr();
  const [base, setBase] = useState<string>();
  const [interval, setIvState] = useState<ChartInterval>(savedInterval);
  const setIv = (v: ChartInterval) => {
    setIvState(v);
    try {
      localStorage.setItem(INTERVAL_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };
  const [selected, setSelected] = useState<number | null>(null);
  const { data, isLoading, error } = useTaskChart(t.id, base, interval);
  const r = useMemo(() => replay(data?.fills ?? []), [data?.fills]);
  const alias = (id: string | null) => t.followers.find((f) => f.connection_id === id)?.alias ?? "—";

  if (isLoading && !data) return <div className="mt-4 h-[520px] border border-border bg-card" />;
  if (error) return <div className="mt-4 border border-border bg-card px-5 py-4 text-xs text-danger">{String((error as Error).message ?? error)}</div>;
  if (!data || data.bases.length === 0)
    return (
      <div className="mt-4 border border-border bg-card">
        <Empty title={tr("暂无成交", "No fills yet")} hint={tr("跟单成交后，K 线上会标出每一笔开仓、加仓与减仓。", "Once orders fill, every open, add and trim is marked on the chart.")} />
      </div>
    );

  const cur = data.base;
  const mark = data.candles.length ? data.candles[data.candles.length - 1].c : null;
  const upnl = mark != null && r.pos !== 0 ? r.pos * (mark - r.avg) : 0;
  const upnlPct = r.avg > 0 && r.pos !== 0 && mark != null ? ((mark - r.avg) / r.avg) * 100 * Math.sign(r.pos) : null;
  const adds = r.fills.filter((f) => f.kind === "add").length;
  const sel = r.fills.find((f) => f.id === selected) ?? null;
  const phone = typeof window !== "undefined" && window.innerWidth < 768;

  return (
    <div className="mt-4 border border-border bg-card max-md:-mx-4 max-md:border-x-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {data.bases.map((b) => (
            <button
              key={b}
              onClick={() => {
                setBase(b);
                setSelected(null);
              }}
              className={clsx("h-7 px-2.5 text-sm transition-colors", b === cur ? "bg-muted text-fg" : "text-muted-fg hover:text-fg")}
            >
              {b}
            </button>
          ))}
        </div>
        <Seg size="sm" value={data.interval} onChange={setIv} options={INTERVALS.map((v) => ({ value: v, label: v }))} />
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-x-4 gap-y-3 border-b border-border px-4 py-3">
        <Stat label={tr("持仓", "Size")} value={r.pos === 0 ? tr("空仓", "Flat") : `${r.pos > 0 ? tr("多", "Long") : tr("空", "Short")} ${qty(Math.abs(r.pos))}`} cls={r.pos > 0 ? "text-success" : r.pos < 0 ? "text-danger" : "text-muted-fg"} />
        <Stat label={tr("持仓均价", "Avg entry")} value={r.pos !== 0 ? price(r.avg) : "—"} cls="text-[var(--chart-avg)]" />
        <Stat label={tr("标记价", "Mark")} value={mark != null ? price(mark) : "—"} />
        <Stat label={tr("浮动盈亏", "Unrealized")} value={
            r.pos !== 0 ? (
              <>
                {signed(upnl)}
                {upnlPct != null ? <span className="ml-1.5 text-xs">{signed(upnlPct, 2)}%</span> : null}
              </>
            ) : (
              "—"
            )
          } cls={pnlClass(upnl)} />
        <Stat label={tr("已实现", "Realized")} value={signed(r.realized)} cls={pnlClass(r.realized)} />
        <Stat label={tr("加仓次数", "Adds")} value={String(adds)} />
      </div>

      {data.candle_error ? <div className="border-b border-border px-4 py-2 text-xs text-warning">{data.candle_error}</div> : null}
      <TaskChart
        candles={data.candles}
        fills={r.fills}
        interval={data.interval}
        avg={r.avg}
        pos={r.pos}
        selected={selected}
        onSelect={setSelected}
        viewKey={`${cur}:${data.interval}`}
        drawKey={`${t.id}:${cur}`}
        compact={phone}
        height={phone ? 300 : 420}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-fg">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span>
              <span className="text-success">▲</span>
              <span className="text-danger">▼</span>
            </span>
            {tr("开 / 平仓", "Open / close")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[8px]">
              <span className="text-success">●</span>
              <span className="text-danger">●</span>
            </span>
            {tr("加 / 减仓（同一根 K 线合并）", "Add / trim (merged per bar)")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t border-dashed border-[var(--chart-avg)]" />
            {tr("持仓均价", "Avg entry")}
          </span>
        </div>
        <span className="max-md:hidden">{tr("画线按币种保存 · Delete 删除选中 · Esc 取消", "Drawings saved per coin · Delete removes · Esc cancels")}</span>
      </div>

      {sel ? <FillCard f={sel} alias={alias(sel.connection_id)} onClose={() => setSelected(null)} /> : null}
      <FillTimeline fills={r.fills} selected={selected} onSelect={setSelected} alias={alias} />
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: ReactNode; cls?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs whitespace-nowrap text-muted-fg">{label}</div>
      <div className={clsx("num mt-0.5 text-sm whitespace-nowrap", cls)}>{value}</div>
    </div>
  );
}

function KindTag({ f }: { f: ReplayedFill }) {
  const cls = f.kind === "open" || f.kind === "add" ? (f.buy ? "bg-success-soft text-success" : "bg-danger-soft text-danger") : "bg-muted text-muted-fg";
  return <span className={clsx("inline-flex h-5 min-w-9 items-center justify-center px-1.5 text-xs", cls)}>{fillLabel(f)}</span>;
}

function FillCard({ f, alias, onClose }: { f: ReplayedFill; alias: string; onClose: () => void }) {
  const tr = useTr();
  const slip = f.slippage_bps != null ? Number(f.slippage_bps) / 100 : null;
  return (
    <div className="anim-rise relative flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-border bg-primary-soft py-3 pr-10 pl-4">
      <div className="flex items-center gap-2">
        <KindTag f={f} />
        <div>
          <div className="text-sm">
            {f.buy ? tr("买入", "Buy") : tr("卖出", "Sell")} <span className="num">{qty(Math.abs(f.delta))}</span>
          </div>
          <div className="text-xs text-muted-fg">
            <span className="num">
              {date(f.ts)} {time(f.ts)}
            </span>{" "}
            · {alias}
          </div>
        </div>
      </div>
      <Stat label={tr("成交价", "Fill")} value={price(f.px)} />
      <Stat label={tr("信号价", "Signal")} value={price(f.ref_px)} />
      <Stat label={tr("滑点", "Slippage")} value={slip != null ? `${signed(slip, 2)}%` : "—"} cls={slip != null && slip > 0.1 ? "text-warning" : undefined} />
      <Stat label={tr("延迟", "Latency")} value={f.latency_ms != null ? `${f.latency_ms} ms` : "—"} />
      <Stat label={tr("成交后持仓", "Size after")} value={qty(f.pos)} />
      <Stat label={tr("成交后均价", "Avg after")} value={f.pos !== 0 ? price(f.avg) : "—"} cls="text-[var(--chart-avg)]" />
      <Stat label={tr("本笔实现盈亏", "Realized")} value={f.realized !== 0 ? signed(f.realized) : "—"} cls={pnlClass(f.realized)} />
      <button className="absolute top-2 right-3 p-1 text-xs text-muted-fg hover:text-fg" onClick={onClose} aria-label={tr("关闭", "Close")}>
        ✕
      </button>
    </div>
  );
}

function FillTimeline({ fills, selected, onSelect, alias }: { fills: ReplayedFill[]; selected: number | null; onSelect: (id: number) => void; alias: (id: string | null) => string }) {
  const tr = useTr();
  const [all, setAll] = useState(false);
  const rows = [...fills].reverse();
  const shown = all ? rows : rows.slice(0, 8);
  if (rows.length === 0) return null;
  return (
    <div className="border-t border-border">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <h3 className="text-sm font-semibold">{tr("加减仓记录", "Adds and trims")}</h3>
        <span className="text-xs text-muted-fg">{tr(`共 ${rows.length} 笔`, `${rows.length} fills`)}</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted-fg">
            <th className="py-2 pl-4 text-left font-normal">{tr("动作", "Action")}</th>
            <th className="text-left font-normal">{tr("时间", "Time")}</th>
            <th className="text-left font-normal max-md:hidden">{tr("账户", "Account")}</th>
            <th className="text-right font-normal">{tr("数量", "Qty")}</th>
            <th className="text-right font-normal">{tr("成交价", "Fill")}</th>
            <th className="text-right font-normal max-md:hidden">{tr("滑点", "Slip")}</th>
            <th className="text-right font-normal">{tr("持仓", "Size")}</th>
            <th className="text-right font-normal max-md:hidden">{tr("均价", "Avg")}</th>
            <th className="pr-4 text-right font-normal">{tr("实现盈亏", "Realized")}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((f) => (
            <tr key={f.id} onClick={() => onSelect(f.id)} className={clsx("cursor-pointer border-t border-border hover:bg-muted", f.id === selected && "bg-primary-soft")}>
              <td className="py-2 pl-4">
                <KindTag f={f} />
              </td>
              <td className="num text-xs whitespace-nowrap text-muted-fg">{date(f.ts)} {time(f.ts).slice(0, 5)}</td>
              <td className="text-xs max-md:hidden">{alias(f.connection_id)}</td>
              <td className={clsx("num text-right", f.buy ? "text-success" : "text-danger")}>{signed(f.delta, Math.abs(f.delta) >= 100 ? 0 : 4)}</td>
              <td className="num text-right">{price(f.px)}</td>
              <td className="num text-right text-xs text-muted-fg max-md:hidden">{f.slippage_bps != null ? `${num(Number(f.slippage_bps) / 100, 2)}%` : "—"}</td>
              <td className="num text-right">{qty(f.pos)}</td>
              <td className="num text-right text-[var(--chart-avg)] max-md:hidden">{f.pos !== 0 ? price(f.avg) : "—"}</td>
              <td className={clsx("num pr-4 text-right", pnlClass(f.realized))}>{f.realized !== 0 ? signed(f.realized) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 8 ? (
        <button className="w-full border-t border-border py-2 text-xs text-muted-fg hover:text-fg" onClick={() => setAll(!all)}>
          {all ? tr("收起", "Show less") : tr(`展开全部 ${rows.length} 笔`, `Show all ${rows.length}`)}
        </button>
      ) : null}
    </div>
  );
}

const STATE_CLS: Record<CompareRow["state"], string> = {
  synced: "text-muted-fg",
  pending: "text-warning",
  expected: "text-muted-fg",
  dust: "text-muted-fg",
  skipped: "text-muted-fg",
  error: "text-danger",
  ignored: "text-muted-fg",
};

function PositionCompare({ rows, running, tolerance }: { rows: CompareRow[]; running: boolean; tolerance: string }) {
  const tr = useTr();
  if (rows.length === 0)
    return <Empty title={running ? tr("等待第一次对账…", "Waiting for the first reconcile…") : tr("任务未运行", "Task not running")} hint={tr("信号源有仓位后，这里并列显示信号源、目标、实际与偏差。", "Source, target, actual and gap appear here once the source holds positions.")} />;
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-fg">
            <th className="py-2 text-left font-normal">{tr("品种", "Coin")}</th>
            <th className="text-left font-normal">{tr("跟单账户", "Follower")}</th>
            <th className="text-right font-normal">{tr("信号源仓位", "Source")}</th>
            <th className="text-right font-normal">{tr("目标仓位", "Target")}</th>
            <th className="text-right font-normal">{tr("实际仓位", "Actual")}</th>
            <th className="text-right font-normal">{tr("偏差", "Gap")}</th>
            <th className="pl-6 text-left font-normal">{tr("目标 / 实际", "Target / actual")}</th>
            <th className="text-right font-normal">{tr("状态", "State")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const t = Math.abs(Number(r.target ?? 0));
            const a = Math.abs(Number(r.actual ?? 0));
            const max = Math.max(t, a, 1e-12);
            const dim = r.state === "skipped" || r.state === "ignored";
            const dev = Number(r.deviation ?? 0);
            return (
              <tr key={`${r.base}-${r.connection_id}`} className={clsx("border-b border-border", r.state === "pending" && "bg-primary-soft")}>
                <td className={clsx("py-2.5", dim && "text-muted-fg")}>
                  <span className="mr-2">{r.base}</span>
                  <SideTag size={r.src} />
                </td>
                <td className={clsx(dim && "text-muted-fg")}>{r.alias}</td>
                <td className="num text-right text-muted-fg">{qty(r.src)}</td>
                <td className="num text-right">{r.target != null ? qty(r.target) : "—"}</td>
                <td className="num text-right">{r.actual != null ? qty(r.actual) : "—"}</td>
                <td className={clsx("num text-right", dev !== 0 && r.state === "pending" ? "text-warning" : "text-muted-fg")}>{r.deviation != null ? (dev === 0 ? "0" : signed(dev, Math.abs(dev) >= 100 ? 0 : 3)) : "—"}</td>
                <td className="pl-6">
                  {r.target != null ? (
                    <div className="flex w-[70px] flex-col gap-[2px]">
                      <div className="h-[3px] bg-muted">
                        <div className="h-full bg-[var(--bar-tgt)]" style={{ width: `${(t / max) * 100}%` }} />
                      </div>
                      <div className="relative h-[3px] bg-muted">
                        <div className="h-full bg-[var(--bar-act)]" style={{ width: `${(Math.min(t, a) / max) * 100}%` }} />
                        {Math.abs(t - a) / max > 0.01 ? <div className="absolute top-0 h-full bg-primary" style={{ left: `${(Math.min(t, a) / max) * 100}%`, width: `${(Math.abs(t - a) / max) * 100}%` }} /> : null}
                      </div>
                    </div>
                  ) : null}
                </td>
                <td className={clsx("text-right text-xs", STATE_CLS[r.state])}>{r.note}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-4 text-xs text-muted-fg">
        {tr(`仓位单位均为币的数量。偏差超过容差 ${num(tolerance, 0)}% 时对账循环自动补单；镜像单先成交产生的偏差不触发补单。`, `Quantities are in coins. The reconcile loop tops up gaps beyond the ${num(tolerance, 0)}% tolerance; gaps from mirrored orders filling first are expected and left alone.`)}
      </p>
    </>
  );
}

function mirrorStatus(m: Mirror, grace: number) {
  switch (m.status) {
    case "live":
      return m.kind === "limit" ? trNow("已挂单", "Resting") : trNow("已挂单，只减仓", "Resting, reduce-only");
    case "filled":
      return trNow("镜像单先成交，预期内", "Filled before source (expected)");
    case "grace": {
      const left = Math.max(0, ((m.grace_until ?? 0) - Date.now()) / 1000);
      return trNow(`源单已成交，宽限期 ${left.toFixed(1)} 秒`, `Source done, grace ${left.toFixed(1)}s`);
    }
    case "not_mirrored":
      return trNow(`未镜像：${m.note ?? ""}`, `Not mirrored: ${m.note ?? ""}`);
    case "failed":
      return trNow(`失败：${m.note ?? ""}`, `Failed: ${m.note ?? ""}`);
    default:
      return m.note ? m.note.replace(/^；/, "") : trNow("已结束", "Done");
  }
  void grace;
}

function Mirrors({ mirrors, enabled, grace }: { mirrors: Mirror[]; enabled: boolean; grace: number }) {
  const tr = useTr();
  if (!enabled) return <Empty title={tr("挂单镜像已关闭", "Order mirroring is off")} hint={tr("任务退化为纯仓位跟随。可在「编辑规则」中开启。", "The task follows positions only. Turn it on under Edit rules.")} />;
  if (mirrors.length === 0) return <Empty title={tr("信号源暂无未成交挂单", "No resting source orders")} />;
  const kind = (m: Mirror) => (m.kind === "limit" ? tr("限价", "Limit") : m.kind === "stop" ? tr("止损", "Stop") : tr("止盈", "Take profit"));
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-fg">
            <th className="py-2 text-left font-normal">{tr("源订单", "Source order")}</th>
            <th className="text-left font-normal">{tr("类型", "Type")}</th>
            <th className="text-right font-normal">{tr("价格 / 触发价", "Price / trigger")}</th>
            <th className="text-right font-normal">{tr("源数量", "Source qty")}</th>
            <th className="pl-6 text-left font-normal">{tr("镜像账户", "Follower")}</th>
            <th className="text-right font-normal">{tr("镜像数量", "Qty")}</th>
            <th className="text-right font-normal">{tr("状态", "Status")}</th>
          </tr>
        </thead>
        <tbody>
          {mirrors.map((m) => (
            <tr key={m.id} className={clsx("border-b border-border", m.status === "done" && "text-muted-fg")}>
              <td className="py-2.5">
                {m.base} {m.buy ? tr("买", "buy") : tr("卖", "sell")} <span className="num text-xs text-muted-fg">#{m.source_order_id.slice(-6)}</span>
              </td>
              <td>{kind(m)}</td>
              <td className="num text-right">{price(m.src_price)}</td>
              <td className="num text-right">{qty(m.src_qty)}</td>
              <td className="pl-6">{m.alias}</td>
              <td className="num text-right">{m.qty ? qty(m.qty) : "—"}</td>
              <td className={clsx("text-right text-xs", m.status === "grace" ? "text-warning" : m.status === "not_mirrored" || m.status === "failed" ? "text-danger" : "text-muted-fg")}>{mirrorStatus(m, grace)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-xs text-muted-fg">
        {tr(`源挂单成交后等待 ${grace / 1000} 秒宽限期让镜像单自行成交，之后撤掉残余镜像单，由仓位差额逻辑市价补齐。`, `After a source order fills, mirrors get a ${grace / 1000}s grace period; leftovers are then cancelled and the position-diff logic tops up at market.`)}
      </p>
    </>
  );
}

function SignalLog({ t }: { t: TD }) {
  const tr = useTr();
  if (t.signals.length === 0) return <Empty title={tr("暂无信号", "No signals yet")} />;
  const desc = (o: TD["signals"][number]["orders"][number]) => {
    if (o.status === "skipped") return `${o.base} ${tr("跳过", "skipped")}：${o.reason ?? ""}`;
    if (o.status === "failed") return `${o.symbol ?? o.base} ${tr("下单失败", "failed")}：${o.reason ?? ""}`;
    const side = o.buy ? tr("买", "buy") : tr("卖", "sell");
    const type = o.order_type === "market" ? tr("市价", "market ") : o.order_type === "limit_ioc" ? "IOC " : "";
    let s = `${type}${side} ${qty(o.fill_qty ?? o.qty)}`;
    if (o.fill_px) s += ` ${tr("成交", "@")} ${price(o.fill_px)}`;
    if (o.slippage_bps) s += tr(`，滑点 ${num(Number(o.slippage_bps) / 100, 2)}%`, `, slip ${num(Number(o.slippage_bps) / 100, 2)}%`);
    if (o.latency_ms != null) s += tr(`，耗时 ${o.latency_ms} ms`, `, ${o.latency_ms} ms`);
    if (o.reason) s += `（${o.reason}）`;
    return s;
  };
  return (
    <div className="flex flex-col">
      {t.signals.map((s) => {
        const fails = s.orders.filter((o) => o.status === "failed");
        const alias = (id: string | null) => t.followers.find((f) => f.connection_id === id)?.alias ?? "";
        return (
          <div key={s.id} className="flex gap-6 border-b border-border py-3">
            <span className="num w-28 shrink-0 text-xs text-muted-fg">{time(s.ts, true)}</span>
            <div className="min-w-0 flex-1">
              <div className={clsx("text-sm", s.kind === "risk" && "text-warning")}>
                {s.kind === "risk" ? "" : tr("信号：", "Signal: ")}
                {s.text}
              </div>
              {s.orders.filter((o) => o.status !== "failed").map((o) => (
                <div key={o.id} className={clsx("mt-1 text-xs", o.status === "skipped" ? "text-warning" : "text-muted-fg")}>
                  {alias(o.connection_id)} {desc(o)}
                </div>
              ))}
              {fails.map((o) => (
                <div key={o.id} className="mt-1 text-xs text-danger">
                  {alias(o.connection_id)} {desc(o)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RulesPanel({ t }: { t: TD }) {
  const tr = useTr();
  const { go } = useUi();
  const r = t.rules;
  const k = t.risk;
  const live = t.live;
  const totalNotional = live?.followers.reduce((a, f) => a + Number(f.notional), 0) ?? 0;
  const margin = r.leverage.margin === "isolated" ? tr("逐仓", "isolated") : tr("全仓", "cross");
  const lev = r.leverage.mode === "follow" ? tr(`跟随信号源，上限 ${r.leverage.cap}×，${margin}`, `Follow source, cap ${r.leverage.cap}×, ${margin}`) : tr(`固定 ${r.leverage.value}×，上限 ${r.leverage.cap}×，${margin}`, `Fixed ${r.leverage.value}×, cap ${r.leverage.cap}×, ${margin}`);
  const tp = r.tpsl;
  const tpslText = tp?.enabled
    ? [tp.tp_pct ? tr(`止盈 +${tp.tp_pct}%`, `TP +${tp.tp_pct}%`) : null, tp.sl_pct ? tr(`止损 −${tp.sl_pct}%`, `SL −${tp.sl_pct}%`) : null, tp.trail_activate_pct ? tr(`移动 +${tp.trail_activate_pct}%/${tp.trail_callback_pct}%`, `Trail +${tp.trail_activate_pct}%/${tp.trail_callback_pct}%`) : null].filter(Boolean).join("，")
    : tr("关", "Off");
  // Percent loss limits are measured against the task's capital.
  const cap = Number(t.capital ?? 0);
  const limitUsd = (v: string | null) => (!v ? null : k.loss_unit === "pct" ? (cap > 0 ? (cap * Number(v)) / 100 : null) : Number(v));
  const syms = r.whitelist.length ? tr(`白名单 ${r.whitelist.length} 个`, `${r.whitelist.length} allowed`) : r.blacklist.length ? tr(`全部，黑名单 ${r.blacklist.length} 个`, `All, ${r.blacklist.length} blocked`) : tr("全部", "All");
  if (r.mode === "watch") {
    const w = r.watch;
    const on = (b?: boolean) => (b === false ? tr("不推送", "Off") : tr("推送", "Pushed"));
    return (
      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-md font-semibold">{tr("观察规则", "Watch rules")}</h2>
          <Button variant="link" className="text-xs" onClick={() => go("wizard", t.id)}>
            {tr("编辑", "Edit")}
          </Button>
        </div>
        <div className="mt-4 flex flex-col">
          <KV k={tr("任务类型", "Type")} v={tr("只观察提醒", "Watch only")} />
          <KV k={tr("开仓", "Opens")} v={on(w?.open)} />
          <KV k={tr("加仓", "Adds")} v={on(w?.add)} />
          <KV k={tr("减仓", "Reductions")} v={on(w?.reduce)} />
          <KV k={tr("平仓与反手", "Closes and flips")} v={on(w?.close)} />
          <KV k={tr("加减仓最小金额", "Min add / trim")} v={w && Number(w.min_notional) > 0 ? `${num(w.min_notional, 0)} USDT` : tr("不限", "Any")} />
          <KV k={tr("品种", "Coins")} v={syms} />
        </div>
        <p className="mt-4 text-xs text-muted-fg">{tr("推送渠道与开关在「设置 · 通知与心跳」。", "Channels and switches live under Settings · Notifications.")}</p>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-md font-semibold">{tr("规则", "Rules")}</h2>
        <Button variant="link" className="text-xs" onClick={() => go("wizard", t.id)}>
          {tr("编辑规则", "Edit rules")}
        </Button>
      </div>
      <div className="mt-4 flex flex-col">
        <KV k={tr("仓位计算", "Sizing")} v={sizingLabel(r)} />
        <KV k={tr("杠杆", "Leverage")} v={lev} />
        <KV k={tr("品种", "Coins")} v={syms} />
        <KV k={tr("启动策略", "On start")} v={r.start === "new_only" ? tr("只跟新开仓位", "New positions only") : tr("同步已有持仓", "Sync existing")} />
        <KV k={tr("停止策略", "On stop")} v={r.stop === "keep" ? tr("保留已跟仓位", "Keep positions") : tr("市价全部平掉", "Close at market")} />
        <KV k={tr("最小变动", "Min change")} v={`${num(r.min_change_usdt, 0)} USDT`} />
        <KV k={tr("挂单镜像", "Mirroring")} v={r.mirror.enabled ? tr(`开，宽限期 ${r.mirror.grace_ms / 1000} 秒`, `On, ${r.mirror.grace_ms / 1000}s grace`) : tr("关", "Off")} />
        <KV k={tr("单仓止盈止损", "Per-position TP / SL")} v={tpslText} />
      </div>
      <div className="my-6 h-px bg-border" />
      <h2 className="text-md font-semibold">{tr("风控", "Risk")}</h2>
      <div className="mt-4 flex flex-col gap-4">
        <Meter label={tr("今日亏损 / 上限", "Loss today / limit")} value={Math.max(0, -Number(t.today_pnl ?? 0))} max={limitUsd(k.daily_loss_limit)} />
        {k.total_loss_limit ? <Meter label={tr("累计亏损 / 上限", "Total loss / limit")} value={Math.max(0, -Number(t.total_pnl ?? 0))} max={limitUsd(k.total_loss_limit)} /> : null}
        {k.profit_target ? <Meter label={tr(`累计盈利 / 目标（${k.profit_action === "close" ? "平仓并暂停" : "暂停"}）`, `PnL / target (${k.profit_action === "close" ? "close" : "pause"})`)} value={Math.max(0, Number(t.total_pnl ?? 0))} max={Number(k.profit_target)} /> : null}
        {k.max_positions ? <KV k={tr("最多同时持有币种", "Max coins held")} v={String(k.max_positions)} /> : null}
        <Meter label={tr("总名义仓位 / 上限", "Total notional / limit")} value={totalNotional} max={k.max_total_notional ? Number(k.max_total_notional) : null} />
        <KV k={tr("单品种名义上限", "Per-coin notional cap")} v={k.max_symbol_notional ? num(k.max_symbol_notional, 0) : tr("不限", "None")} />
        <KV k={tr("最大滑点", "Max slippage")} v={`${num(k.max_slippage_pct, 2)}%`} />
        <KV k={tr(`信号源失联 ${k.source_lost_secs} 秒`, `Source lost ${k.source_lost_secs}s`)} v={lostLabel(k)} />
        {k.source_dd_pct ? (
          <Meter
            label={tr(`信号源回撤 / 熔断线（${k.source_dd_action === "close" ? "平仓并暂停" : "暂停"}）`, `Source drawdown / breaker (${k.source_dd_action === "close" ? "close" : "pause"})`)}
            value={Number(live?.source_dd_pct ?? 0)}
            max={Number(k.source_dd_pct)}
            unit="%"
          />
        ) : null}
      </div>
      <div className="my-6 h-px bg-border" />
      <h2 className="text-md font-semibold">{tr("跟单账户", "Followers")}</h2>
      <div className="mt-4 flex flex-col gap-3">
        {t.followers.map((f) => (
          <div key={f.connection_id} className="flex items-center justify-between text-xs">
            <span>{f.alias}</span>
            {f.overrides?.sizing ? <span className="text-primary">{tr("覆盖：", "Override: ")}{sizingLabel({ ...r, sizing: f.overrides.sizing })}</span> : <span className="text-muted-fg">{tr("继承任务规则", "Inherits task rules")}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function lostLabel(k: Risk) {
  return { keep: trNow("保持仓位", "Keep"), pause: trNow("暂停任务", "Pause"), close: trNow("平仓", "Close") }[k.source_lost_action];
}

function KV({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 text-xs">
      <span className="text-muted-fg">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}

function Meter({ label, value, max, unit }: { label: string; value: number; max: number | null; unit?: string }) {
  const pct = max ? Math.min(1, value / max) : 0;
  const dp = unit === "%" ? 1 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-fg">{label}</span>
        <span className={clsx("num", pct > 0.85 && "text-primary")}>
          {num(value, dp)}
          {unit ?? ""} / {max ? num(max, dp) : "—"}
          {max ? (unit ?? "") : ""}
        </span>
      </div>
      <div className="mt-1.5 h-1 bg-muted">
        <div className={clsx("h-full", pct > 0.85 ? "bg-primary" : "bg-fg")} style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

function AuditExportDialog({ task, onClose }: { task: TaskSummary; onClose: () => void }) {
  const tr = useTr();
  const toast = useUi((s) => s.toast);
  const [range, setRange] = useState<LogFilter["range"]>("all");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const { csv, rows } = await api.exportTaskAudit(task.id, range);
      const safe = task.name.replace(/[\\/:*?"<>|\s]+/g, "_");
      downloadText(`merchandiser-audit-${safe}-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
      toast(tr(`已导出 ${rows} 条`, `Exported ${rows} rows`));
      onClose();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const fields: [string, string][] = [
    [tr("时间", "Time"), tr("源成交时间、信号检测时间、我方成交时间，检测延迟与时间偏差（毫秒）", "Source fill, detection and our fill times; detection delay and time gap (ms)")],
    [tr("仓位", "Position"), tr("双方仓位前后、变动比例与占权益百分比，及其偏差（百分点）", "Size before / after, change ratio and share of equity on both sides, with the gap (pp)")],
    [tr("价格", "Price"), tr("源成交价与我方成交均价，价格偏差为正表示我方成交更差", "Source price vs. our average fill; a positive gap means we filled worse")],
    [tr("盈利", "Return"), tr("减仓 / 平仓时双方相对持仓均价的收益率与已实现盈亏", "On reduces and closes: return against average entry, and realised PnL, for both sides")],
  ];
  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title={tr("导出偏差数据", "Export deviations")}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button variant="primary" loading={busy} onClick={run}>
            <Download size={14} />
            {tr("导出 CSV", "Export CSV")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-fg">
        {tr("每个信号源动作 × 每个跟单账户一行，对比信号源与我方的实际执行，用于数据校验。", "One row per source action and follower, comparing what the source did with what we did, for verification.")}
      </p>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-sm">{tr("时间范围", "Range")}</span>
        <Seg
          size="sm"
          value={range}
          onChange={setRange}
          options={[
            { value: "today", label: tr("今日", "Today") },
            { value: "7d", label: tr("7 天", "7d") },
            { value: "30d", label: tr("30 天", "30d") },
            { value: "all", label: tr("全部", "All") },
          ]}
        />
      </div>
      <dl className="mt-4 flex flex-col gap-2 border-t border-border pt-4 text-xs">
        {fields.map(([k, v]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-10 shrink-0 text-fg">{k}</dt>
            <dd className="text-muted-fg">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-muted-fg">
        {tr(
          "源价格按持仓变化推算，减仓价取检测时标记价。我方持仓按本任务成交回放，不含任务启动前已有的仓位。升级前产生的信号没有源价格。",
          "Source prices are inferred from position changes, with reduces priced at the mark when detected. Our side is replayed from this task's fills and excludes positions held before it started. Signals recorded before this update have no source price.",
        )}
      </p>
    </Modal>
  );
}

export function StopDialog({ task, onClose }: { task: TaskSummary; onClose: () => void }) {
  const tr = useTr();
  const [close, setClose] = useState(task.rules.stop === "close_all");
  const stop = useAction(() => api.taskAction(task.id, "stop", close), { ok: tr("任务已停止", "Task stopped"), invalidate: [["tasks"], ["task"]] });
  return (
    <Modal
      open
      onClose={onClose}
      title={tr(`停止「${task.name}」`, `Stop "${task.name}"`)}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button
            variant="danger"
            loading={stop.isPending}
            onClick={async () => {
              await stop.mutateAsync(undefined);
              onClose();
            }}
          >
            {close ? tr("停止并平仓", "Stop and close") : tr("停止任务", "Stop task")}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted-fg">{tr("停止后不再跟随信号源，镜像挂单会被撤销。", "Copying stops and mirrored orders are cancelled.")}</p>
      <Radio checked={!close} onChange={() => setClose(false)} label={tr("保留已跟仓位", "Keep positions")} />
      <Radio checked={close} onChange={() => setClose(true)} label={tr("市价全部平掉", "Close everything at market")} hint={tr("各跟单账户的全部仓位将以只减仓市价单平掉。", "All positions on each follower are closed with reduce-only market orders.")} />
    </Modal>
  );
}
