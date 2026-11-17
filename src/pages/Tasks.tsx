import clsx from "clsx";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Spark } from "../components/Charts";
import { Button, Confirm, Empty, Loading } from "../components/ui";
import { api, type Rules, type TaskPnl, type TaskSummary } from "../lib/api";
import { date, days, num, pnlClass, qty, signed } from "../lib/format";
import { trNow, useTr } from "../lib/i18n";
import { useAction, useOverview, usePnlCurve, useTasks } from "../lib/queries";
import { useUi } from "../lib/store";
import { sourceLabel, StatusText } from "./Overview";
import { StopDialog } from "./TaskDetail";

export function sizingLabel(r: Rules) {
  const k = Number(r.sizing.k);
  switch (r.sizing.mode) {
    case "equity_ratio":
      return trNow(`权益比例 ×${k.toFixed(1)}`, `Equity ratio ×${k.toFixed(1)}`);
    case "fixed_multiple":
      return trNow(`固定倍数 k=${k}`, `Fixed multiple k=${k}`);
    default:
      return trNow(`固定名义 ${Number(r.sizing.notional)} USDT`, `Fixed ${Number(r.sizing.notional)} USDT`);
  }
}

export function followersLabel(t: TaskSummary) {
  const plats = Array.from(new Set(t.followers.map((f) => f.platform)));
  if (t.followers.length === 1) return t.followers[0].alias;
  if (plats.length === 1) return trNow(`${platName(plats[0])} ${t.followers.length} 个`, `${t.followers.length} on ${platName(plats[0])}`);
  return plats.map(platName).join(trNow("、", ", "));
}

function platName(p: string) {
  return ({ okx: "OKX", binance: trNow("币安", "Binance"), gate: "Gate", hyperliquid: "HL", paper: trNow("模拟", "Paper") } as Record<string, string>)[p] ?? p;
}


/** Follower holdings per coin from the last reconcile, signed. */
function holdings(t: TaskSummary) {
  const m = new Map<string, number>();
  for (const r of t.live?.rows ?? []) {
    const a = Number(r.actual ?? 0);
    if (a) m.set(r.base, (m.get(r.base) ?? 0) + a);
  }
  return [...m.entries()].sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
}

function subline(t: TaskSummary) {
  if (t.status === "stopped") return `${date(t.stopped_at ?? t.created_at)} ${trNow("停止", "stopped")}${t.rules.stop === "keep" ? trNow("，仓位已保留", ", positions kept") : ""}`;
  return `${sourceLabel(t)} → ${followersLabel(t)}${t.started_at ? trNow(` · 运行 ${days(t.started_at)} 天`, ` · ${days(t.started_at)}d`) : ""}`;
}

function Holdings({ t, max = 3 }: { t: TaskSummary; max?: number }) {
  const tr = useTr();
  const h = holdings(t);
  if (!h.length) return <span className="text-xs text-muted-fg">{t.live ? tr("无持仓", "Flat") : "—"}</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {h.slice(0, max).map(([b, v]) => (
        <span key={b} className={clsx("inline-flex h-6 items-center gap-1 border-l-2 bg-muted px-1.5 text-xs", v > 0 ? "border-success" : "border-danger")}>
          <span className="font-semibold">{b}</span>
          <span className={clsx("num", v > 0 ? "text-success" : "text-danger")}>
            {v > 0 ? tr("多", "L") : tr("空", "S")} {qty(Math.abs(v))}
          </span>
        </span>
      ))}
      {h.length > max ? <span className="self-center text-xs text-muted-fg">+{h.length - max}</span> : null}
    </div>
  );
}

function AddsReduces({ t }: { t: TaskSummary }) {
  const tr = useTr();
  if (!t.week_adds && !t.week_reduces) return <span className="text-xs text-muted-fg">—</span>;
  return (
    <span className="num text-sm whitespace-nowrap">
      <span className="text-success">
        {tr("加", "+")} {t.week_adds}
      </span>
      <span className="mx-2 text-muted-fg">/</span>
      <span className="text-danger">
        {tr("减", "−")} {t.week_reduces}
      </span>
    </span>
  );
}

type Filter = "all" | "running" | "paused" | "stopped";

export function Tasks() {
  const tr = useTr();
  const { go } = useUi();
  const { data, isLoading } = useTasks();
  const { data: curve } = usePnlCurve("all");
  const { data: ov } = useOverview();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [stopping, setStopping] = useState<TaskSummary | null>(null);
  const [deleting, setDeleting] = useState<TaskSummary | null>(null);
  const action = useAction(({ id, a }: { id: string; a: "start" | "resume" | "pause" }) => api.taskAction(id, a), { invalidate: [["tasks"]] });
  const del = useAction(api.deleteTask, { ok: tr("已删除", "Deleted"), invalidate: [["tasks"]] });

  const tasks = useMemo(() => [...(data ?? [])].sort((a, b) => Number(b.total_pnl ?? 0) - Number(a.total_pnl ?? 0)), [data]);
  const counts = useMemo(() => ({ all: tasks.length, running: tasks.filter((t) => t.status === "running").length, paused: tasks.filter((t) => t.status === "paused").length, stopped: tasks.filter((t) => t.status === "stopped").length }), [tasks]);
  const shown = tasks.filter((t) => (filter === "all" || t.status === filter) && (!q || `${t.name} ${t.source_name} ${t.source_address ?? ""} ${holdings(t).map((h) => h[0]).join(" ")}`.toLowerCase().includes(q.toLowerCase())));
  const perf = new Map<string, TaskPnl>((curve?.tasks ?? []).map((p) => [p.task_id, p]));

  if (isLoading) return <Loading />;

  const total = tasks.reduce((a, t) => a + Number(t.total_pnl ?? 0), 0);
  const win = tasks.filter((t) => Number(t.total_pnl ?? 0) > 0).length;
  const loss = tasks.filter((t) => Number(t.total_pnl ?? 0) < 0).length;
  const notional = tasks.reduce((a, t) => a + (t.live?.followers.reduce((x, f) => x + Number(f.notional || 0), 0) ?? 0), 0);
  const adds = tasks.reduce((a, t) => a + t.week_adds, 0);
  const reduces = tasks.reduce((a, t) => a + t.week_reduces, 0);
  const roi = (t: TaskSummary) => {
    const p = perf.get(t.id);
    return p && p.start_equity > 0 && t.total_pnl != null ? (Number(t.total_pnl) / p.start_equity) * 100 : null;
  };

  const actions = (t: TaskSummary) =>
    t.status === "running" ? (
      <>
        <Button variant="ghost" size="sm" onClick={() => action.mutate({ id: t.id, a: "pause" })}>
          {tr("暂停", "Pause")}
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-fg" onClick={() => setStopping(t)}>
          {tr("停止", "Stop")}
        </Button>
      </>
    ) : t.status === "paused" ? (
      <>
        <Button variant="ghost" size="sm" onClick={() => action.mutate({ id: t.id, a: t.started_at ? "resume" : "start" })}>
          {t.started_at ? tr("恢复", "Resume") : tr("启动", "Start")}
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-fg" onClick={() => setStopping(t)}>
          {tr("停止", "Stop")}
        </Button>
      </>
    ) : (
      <>
        <Button variant="ghost" size="sm" onClick={() => action.mutate({ id: t.id, a: "start" })}>
          {tr("重新启动", "Restart")}
        </Button>
        <Button variant="ghost" size="sm" className="text-danger" onClick={() => setDeleting(t)}>
          {tr("删除", "Delete")}
        </Button>
      </>
    );

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 py-4 md:px-6 md:py-6">
      {/* Summary */}
      <div className="grid grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))] items-end gap-x-6 gap-y-4 border border-border bg-card px-4 py-4 md:px-5 max-md:grid-cols-3">
        <div className="max-md:col-span-3">
          <div className="text-xs text-muted-fg">{tr("全部任务累计盈亏（USDT）", "All tasks, total PnL (USDT)")}</div>
          <div className={clsx("num mt-1 text-[30px] leading-tight font-semibold tracking-[-0.5px]", pnlClass(total))}>{signed(total)}</div>
        </div>
        <Sum label={tr("盈利 / 亏损任务", "Winning / losing")}>
          <span className="text-success">{win}</span>
          <span className="mx-1.5 text-muted-fg">/</span>
          <span className="text-danger">{loss}</span>
        </Sum>
        <Sum label={tr("持仓名义", "Notional")}>{num(notional, 0)}</Sum>
        <Sum label={tr("本周加仓 / 减仓", "Adds / trims, 7d")}>
          <span className="text-success">{adds}</span>
          <span className="mx-1.5 text-muted-fg">/</span>
          <span className="text-danger">{reduces}</span>
        </Sum>
        <Sum label={tr("信号→下单 P95", "Signal→order P95")} className="max-md:hidden">
          {ov?.latency_p95 != null ? `${ov.latency_p95} ms` : "—"}
        </Sum>
      </div>

      {/* Filters */}
      <div className="mt-4 mb-3 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex gap-5 border-b border-border max-md:w-full max-md:gap-4 md:border-b-0">
          {(["all", "running", "paused", "stopped"] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={clsx("relative h-8 text-sm whitespace-nowrap", filter === f ? "font-semibold text-fg" : "text-muted-fg hover:text-fg")}>
              {{ all: tr("全部", "All"), running: tr("运行中", "Running"), paused: tr("已暂停", "Paused"), stopped: tr("已停止", "Stopped") }[f]}
              <span className="num ml-1 text-xs text-muted-fg">{counts[f]}</span>
              {filter === f ? <span className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" /> : null}
            </button>
          ))}
        </div>
        <div className="flex-1 max-md:hidden" />
        <div className="flex h-8 items-center gap-2 rounded-md border border-input bg-bg px-3 focus-within:border-ring max-md:flex-1 md:w-[260px]">
          <Search size={14} className="text-muted-fg" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("搜索任务、信号源或品种", "Search tasks, sources or coins")} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-fg" />
        </div>
        <Button variant="primary" onClick={() => go("wizard")}>
          <Plus size={14} />
          <span className="max-md:hidden">{tr("新建任务", "New task")}</span>
        </Button>
      </div>

      {tasks.length === 0 ? (
        <div className="border border-border bg-card">
          <Empty title={tr("还没有跟单任务", "No tasks yet")} hint={tr("新建向导会依次引导你选择信号源、跟单账户、规则与风控。", "The wizard walks you through source, followers, rules and risk.")} />
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="anim-fade overflow-hidden border border-border bg-card max-md:hidden" key={filter}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-fg">
                  <th className="px-4 py-2.5 font-normal">{tr("任务", "Task")}</th>
                  <th className="px-2 text-right font-normal">{tr("累计盈亏 / ROI", "Total / ROI")}</th>
                  <th className="px-4 font-normal max-lg:hidden">{tr("14 天", "14d")}</th>
                  <th className="px-2 text-right font-normal">{tr("今日", "Today")}</th>
                  <th className="px-4 font-normal">{tr("当前持仓", "Holdings")}</th>
                  <th className="px-2 font-normal max-lg:hidden">{tr("本周加 / 减仓", "Adds / trims 7d")}</th>
                  <th className="px-2 font-normal">{tr("状态", "Status")}</th>
                  <th className="px-4 text-right font-normal">{tr("操作", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => {
                  const dim = t.status === "stopped";
                  const r = roi(t);
                  return (
                    <tr key={t.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-muted" onClick={() => go("task", t.id)}>
                      <td className="max-w-[280px] px-4 py-3">
                        <div className={clsx("truncate font-semibold", dim && "font-normal text-muted-fg")}>{t.name}</div>
                        <div className="mt-0.5 truncate text-xs text-muted-fg">{subline(t)}</div>
                      </td>
                      <td className="px-2 text-right">
                        <div className={clsx("num", pnlClass(t.total_pnl))}>{signed(t.total_pnl)}</div>
                        <div className={clsx("num text-xs", pnlClass(r))}>{r != null ? `${signed(r, 2)}%` : "—"}</div>
                      </td>
                      <td className="px-4 max-lg:hidden">
                        <Spark values={(perf.get(t.id)?.daily ?? []).map((d) => d[1])} />
                      </td>
                      <td className={clsx("num px-2 text-right", pnlClass(t.today_pnl))}>{t.status === "stopped" ? "—" : signed(t.today_pnl)}</td>
                      <td className="px-4">
                        <Holdings t={t} />
                      </td>
                      <td className="px-2 max-lg:hidden">
                        <AddsReduces t={t} />
                      </td>
                      <td className="max-w-[160px] px-2 text-xs">
                        <StatusText t={t} />
                      </td>
                      <td className="px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        {actions(t)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 ? <div className="py-10 text-center text-sm text-muted-fg">{tr("没有匹配的任务", "No matching tasks")}</div> : null}
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 md:hidden">
            {shown.map((t) => {
              const r = roi(t);
              const alarm = t.status === "paused" && !!t.pause_reason && t.pause_reason !== "手动暂停";
              return (
                <div key={t.id} className={clsx("border bg-card", alarm ? "border-danger" : "border-border")}>
                  <button className="w-full px-4 pt-3 text-left" onClick={() => go("task", t.id)}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className={clsx("truncate text-md font-semibold", t.status === "stopped" && "text-muted-fg")}>{t.name}</div>
                        <div className={clsx("truncate text-xs", alarm ? "text-danger" : "text-muted-fg")}>{alarm ? t.pause_reason : subline(t)}</div>
                      </div>
                      <span className="shrink-0 text-xs">
                        <StatusText t={{ status: t.status, pause_reason: alarm ? null : t.pause_reason }} />
                      </span>
                    </div>
                    <div className="mt-2 flex items-end justify-between gap-3">
                      <div>
                        <span className={clsx("num text-xl font-semibold", pnlClass(t.total_pnl))}>{signed(t.total_pnl)}</span>
                        {r != null ? <span className={clsx("num ml-2 text-xs", pnlClass(r))}>{signed(r, 2)}%</span> : null}
                      </div>
                      <Spark values={(perf.get(t.id)?.daily ?? []).map((d) => d[1])} width={88} height={30} />
                    </div>
                  </button>
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
                    <Holdings t={t} max={2} />
                    {t.status === "paused" ? (
                      <Button size="sm" onClick={() => action.mutate({ id: t.id, a: t.started_at ? "resume" : "start" })}>
                        {tr("恢复", "Resume")}
                      </Button>
                    ) : (
                      <span className="shrink-0 text-xs text-muted-fg">
                        {tr("本周", "7d")} <AddsReduces t={t} />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {shown.length === 0 ? <div className="py-10 text-center text-sm text-muted-fg">{tr("没有匹配的任务", "No matching tasks")}</div> : null}
          </div>
        </>
      )}
      <p className="mt-4 text-xs text-muted-fg">{tr("盈亏按跟单账户权益变化计算；加 / 减仓次数统计信号源近 7 天的仓位变化。", "PnL comes from follower equity changes; adds and trims count the source's position changes over 7 days.")}</p>
      {stopping ? <StopDialog task={stopping} onClose={() => setStopping(null)} /> : null}
      <Confirm
        open={!!deleting}
        onClose={() => setDeleting(null)}
        danger
        title={tr("删除任务", "Delete task")}
        body={tr(`删除「${deleting?.name}」及其镜像记录。执行日志会保留。`, `Delete "${deleting?.name}" and its mirror records. Logs are kept.`)}
        confirmLabel={tr("删除", "Delete")}
        busy={del.isPending}
        onConfirm={async () => {
          await del.mutateAsync(deleting!.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}

function Sum({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx("min-w-0", className)}>
      <div className="truncate text-xs text-muted-fg">{label}</div>
      <div className="num mt-1 text-lg whitespace-nowrap">{children}</div>
    </div>
  );
}
