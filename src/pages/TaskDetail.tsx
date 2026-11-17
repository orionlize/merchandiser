import clsx from "clsx";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { fillLabel, TaskChart } from "../components/TaskChart";
import { Button, Drawer, Empty, Loading, Modal, Radio, Seg, SideTag, Tabs } from "../components/ui";
import { api, type ChartInterval, type CompareRow, type Mirror, type Risk, type TaskDetail as TD, type TaskSummary } from "../lib/api";
import { ago, date, num, pnlClass, price, qty, signed, time } from "../lib/format";
import { trNow, useTr } from "../lib/i18n";
import { useAction, useTask, useTaskChart } from "../lib/queries";
import { replay, type ReplayedFill } from "../lib/replay";
import { useUi } from "../lib/store";
import { sourceLabel } from "./Overview";
import { sizingLabel } from "./Tasks";

export function TaskDetail() {
  const tr = useTr();
  const { route, go } = useUi();
  const { data: t, isLoading } = useTask(route.id);
  const [tab, setTab] = useState<"pos" | "mirror" | "log">("pos");
  const [stopping, setStopping] = useState(false);
  const [rules, setRules] = useState(false);
  const act = useAction(({ a }: { a: "start" | "resume" | "pause" | "reconcile" }) => api.taskAction(route.id!, a), { invalidate: [["task"], ["tasks"]] });

  if (isLoading || !t) return <Loading />;
  const live = t.live;
  const liveMirrors = t.mirrors.filter((m) => m.status !== "done");

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
            <span className="truncate text-xs text-muted-fg md:hidden">
              {sourceLabel(t)} → {t.followers.length} {tr("个账户", "accounts")}
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
            <Button disabled={t.status !== "running"} onClick={() => act.mutate({ a: "reconcile" })}>
              <RefreshCw size={14} />
              {tr("立即对账", "Reconcile now")}
            </Button>
            {t.status !== "stopped" ? (
              <Button variant="danger-text" onClick={() => setStopping(true)}>
                {tr("停止任务…", "Stop…")}
              </Button>
            ) : null}
          </div>
        </div>
        {t.pause_reason && t.status === "paused" ? <div className="mt-2 text-xs text-warning">{t.pause_reason}</div> : null}
        {live?.last_error ? <div className="mt-2 text-xs text-danger">{live.last_error}</div> : null}

        <PnlHero t={t} />
        <ChartCard t={t} />

        <Tabs
          className="mt-6"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "pos", label: tr("仓位对比", "Positions") },
            { value: "mirror", label: `${tr("挂单镜像", "Mirrored orders")} ${liveMirrors.length || ""}` },
            { value: "log", label: tr("执行日志", "Execution log") },
          ]}
        />
        <div key={tab} className="anim-rise mt-4 overflow-x-auto max-md:[&_table]:min-w-[640px]">
          {tab === "pos" ? <PositionCompare rows={live?.rows ?? []} running={t.status === "running"} tolerance={t.rules.tolerance_pct} /> : null}
          {tab === "mirror" ? <Mirrors mirrors={t.mirrors} enabled={t.rules.mirror.enabled} grace={t.rules.mirror.grace_ms} /> : null}
          {tab === "log" ? <SignalLog t={t} /> : null}
        </div>
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
        <Button disabled={t.status !== "running"} onClick={() => act.mutate({ a: "reconcile" })}>
          <RefreshCw size={14} />
          <span className="max-sm:hidden">{tr("对账", "Reconcile")}</span>
        </Button>
        {t.status !== "stopped" ? (
          <Button variant="danger-text" onClick={() => setStopping(true)}>
            {tr("停止", "Stop")}
          </Button>
        ) : null}
        {t.status === "running" ? (
          <Button variant="primary" className="flex-1" onClick={() => act.mutate({ a: "pause" })}>
            {tr("暂停跟单", "Pause")}
          </Button>
        ) : (
          <Button variant="primary" className="flex-1" onClick={() => act.mutate({ a: t.started_at && t.status === "paused" ? "resume" : "start" })}>
            {t.status === "stopped" ? tr("重新启动", "Restart") : t.started_at ? tr("恢复跟单", "Resume") : tr("启动", "Start")}
          </Button>
        )}
      </div>
      {stopping ? <StopDialog task={t} onClose={() => setStopping(false)} /> : null}
    </div>
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

function PnlHero({ t }: { t: TD }) {
  const tr = useTr();
  const lang = useUi((s) => s.lang);
  const live = t.live;
  const upnl = live?.followers.reduce((a, f) => a + Number(f.upnl || 0), 0);
  const notional = live?.followers.reduce((a, f) => a + Number(f.notional || 0), 0);
  return (
    <div className="mt-4 grid grid-cols-[minmax(220px,1.4fr)_repeat(3,minmax(0,1fr))] border border-border bg-card max-lg:grid-cols-3 max-md:-mx-4 max-md:border-x-0">
      <div className="border-r border-border px-4 py-4 max-lg:col-span-3 max-lg:border-r-0 max-lg:border-b md:px-5">
        <div className="text-xs text-muted-fg">{tr("累计盈亏 USDT", "Total PnL USDT")}</div>
        <div className={clsx("num mt-1 text-[32px] leading-10 font-semibold tracking-[-0.5px]", pnlClass(t.total_pnl))}>{signed(t.total_pnl)}</div>
        <div className="mt-1 flex gap-4 text-xs">
          <span className="text-muted-fg">
            {tr("今日", "Today")} <span className={clsx("num", pnlClass(t.today_pnl))}>{signed(t.today_pnl)}</span>
          </span>
        </div>
      </div>
      <HeroCell label={tr("持仓浮盈", "Unrealized")} value={upnl != null ? signed(upnl) : "—"} cls={pnlClass(upnl)} sub={notional != null ? tr(`名义 ${num(notional, 0)}`, `Notional ${num(notional, 0)}`) : undefined} />
      <HeroCell label={tr("名义偏差", "Notional gap")} value={live ? `${num(live.deviation_pct, 1)}%` : "—"} cls={live && Math.abs(Number(live.deviation_pct)) > Number(t.rules.tolerance_pct) ? "text-warning" : undefined} sub={tr(`容差 ${num(t.rules.tolerance_pct, 0)}%`, `Tolerance ${num(t.rules.tolerance_pct, 0)}%`)} />
      <HeroCell label={tr("延迟 P95", "Latency P95")} value={t.latency_p95 != null ? `${t.latency_p95} ms` : "—"} sub={`${tr("上次对账", "Reconciled")} ${ago(live?.last_reconcile, lang === "en")}`} last />
    </div>
  );
}

function HeroCell({ label, value, cls, sub, last }: { label: string; value: string; cls?: string; sub?: string; last?: boolean }) {
  return (
    <div className={clsx("min-w-0 px-4 py-3 md:px-5 md:py-4", !last && "border-r border-border")}>
      <div className="truncate text-xs text-muted-fg">{label}</div>
      <div className={clsx("num mt-1 truncate text-lg md:text-xl", cls)}>{value}</div>
      {sub ? <div className="mt-1 truncate text-xs text-muted-fg">{sub}</div> : null}
    </div>
  );
}

const INTERVALS: ChartInterval[] = ["15m", "1h", "4h", "1d"];

function ChartCard({ t }: { t: TD }) {
  const tr = useTr();
  const [base, setBase] = useState<string>();
  const [interval, setIv] = useState<ChartInterval>("4h");
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
      <div className="relative px-1 pt-2">
        <TaskChart candles={data.candles} fills={r.fills} interval={data.interval} avg={r.avg} pos={r.pos} selected={selected} onSelect={setSelected} viewKey={`${cur}:${data.interval}`} height={typeof window !== "undefined" && window.innerWidth < 768 ? 300 : 420} />
        <div className="pointer-events-none absolute top-3 left-4 flex gap-4 text-xs text-muted-fg">
          <span className="flex items-center gap-1.5">
            <span className="text-success">▲</span>
            {tr("开 / 加仓", "Open / add")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-danger">▼</span>
            {tr("减 / 平仓", "Trim / close")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t border-dashed border-[var(--chart-avg)]" />
            {tr("持仓均价", "Avg entry")}
          </span>
        </div>
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
  const lev = r.leverage.mode === "follow" ? tr(`跟随信号源，上限 ${r.leverage.cap}×`, `Follow source, cap ${r.leverage.cap}×`) : tr(`固定 ${r.leverage.value}×，上限 ${r.leverage.cap}×`, `Fixed ${r.leverage.value}×, cap ${r.leverage.cap}×`);
  const syms = r.whitelist.length ? tr(`白名单 ${r.whitelist.length} 个`, `${r.whitelist.length} allowed`) : r.blacklist.length ? tr(`全部，黑名单 ${r.blacklist.length} 个`, `All, ${r.blacklist.length} blocked`) : tr("全部", "All");
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
      </div>
      <div className="my-6 h-px bg-border" />
      <h2 className="text-md font-semibold">{tr("风控", "Risk")}</h2>
      <div className="mt-4 flex flex-col gap-4">
        <Meter label={tr("今日亏损 / 上限", "Loss today / limit")} value={Math.max(0, -Number(t.today_pnl ?? 0))} max={k.daily_loss_limit ? Number(k.daily_loss_limit) : null} />
        <Meter label={tr("总名义仓位 / 上限", "Total notional / limit")} value={totalNotional} max={k.max_total_notional ? Number(k.max_total_notional) : null} />
        <KV k={tr("单品种名义上限", "Per-coin notional cap")} v={k.max_symbol_notional ? num(k.max_symbol_notional, 0) : tr("不限", "None")} />
        <KV k={tr("最大滑点", "Max slippage")} v={`${num(k.max_slippage_pct, 2)}%`} />
        <KV k={tr(`信号源失联 ${k.source_lost_secs} 秒`, `Source lost ${k.source_lost_secs}s`)} v={lostLabel(k)} />
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

function Meter({ label, value, max }: { label: string; value: number; max: number | null }) {
  const pct = max ? Math.min(1, value / max) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-fg">{label}</span>
        <span className={clsx("num", pct > 0.85 && "text-primary")}>
          {num(value, 0)} / {max ? num(max, 0) : "—"}
        </span>
      </div>
      <div className="mt-1.5 h-1 bg-muted">
        <div className={clsx("h-full", pct > 0.85 ? "bg-primary" : "bg-fg")} style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
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
