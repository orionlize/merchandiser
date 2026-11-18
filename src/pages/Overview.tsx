import clsx from "clsx";
import { ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { maxDrawdown, PnlCurveChart, Spark } from "../components/Charts";
import { PositionsTable } from "../components/Positions";
import { Button, Confirm, Dot, Empty, Loading, PlatformTag, Seg } from "../components/ui";
import { api, type Overview as OV, type PnlRange, type TaskPnl, type TaskSummary } from "../lib/api";
import { num, pnlClass, shortAddr, signed, time } from "../lib/format";
import { trNow, useTr } from "../lib/i18n";
import { useAction, useOverview, usePnlCurve } from "../lib/queries";
import { useUi } from "../lib/store";

export function sourceLabel(t: Pick<TaskSummary, "source_kind" | "source_name" | "source_address" | "source_platform">) {
  if (t.source_kind === "hl_address") return `HL ${shortAddr(t.source_address)}`;
  return t.source_name;
}

export const RANGES: { value: PnlRange; zh: string; en: string }[] = [
  { value: "today", zh: "今日", en: "Today" },
  { value: "7d", zh: "7 天", en: "7D" },
  { value: "30d", zh: "30 天", en: "30D" },
  { value: "all", zh: "全部", en: "All" },
];

export function rangeLabel(r: PnlRange) {
  return { today: trNow("今日", "Today's"), "7d": trNow("近 7 天", "7-day"), "30d": trNow("近 30 天", "30-day"), all: trNow("累计", "All-time") }[r];
}

/** Copy fidelity: how closely running tasks track their target, 100% = no gap. */
function fidelity(tasks: TaskSummary[]) {
  const live = tasks.filter((t) => t.status === "running" && t.live);
  if (!live.length) return null;
  return live.reduce((a, t) => a + Math.max(0, 100 - Math.abs(Number(t.live!.deviation_pct))), 0) / live.length;
}

interface Attention {
  key: string;
  level: "error" | "warn";
  title: string;
  detail: string;
  task?: string;
}

function attention(data: OV): Attention[] {
  const out: Attention[] = [];
  for (const t of data.tasks) {
    if (t.status === "paused" && t.pause_reason) out.push({ key: `p${t.id}`, level: "error", title: trNow(`「${t.name}」已暂停`, `"${t.name}" paused`), detail: t.pause_reason, task: t.id });
    else if (t.live?.last_error) out.push({ key: `e${t.id}`, level: "error", title: trNow(`「${t.name}」执行出错`, `"${t.name}" error`), detail: t.live.last_error, task: t.id });
    else if (t.status === "running" && t.live && Math.abs(Number(t.live.deviation_pct)) > Number(t.rules.tolerance_pct))
      out.push({ key: `d${t.id}`, level: "warn", title: trNow(`「${t.name}」仓位偏差 ${num(t.live.deviation_pct, 1)}%`, `"${t.name}" gap ${num(t.live.deviation_pct, 1)}%`), detail: trNow("超过容差，正在补单", "Beyond tolerance, topping up"), task: t.id });
  }
  const day = Date.now() - 86_400_000;
  for (const a of data.alerts) {
    if (out.length >= 6) break;
    if (a.ts < day || (a.level !== "error" && a.level !== "warn")) continue;
    out.push({ key: `a${a.id}`, level: a.level, title: a.title, detail: `${time(a.ts).slice(0, 5)} ${a.detail ?? ""}`, task: a.task_id ?? undefined });
  }
  return out;
}

export function Overview() {
  const tr = useTr();
  const { go } = useUi();
  const { data, isLoading } = useOverview();
  const [range, setRange] = useState<PnlRange>("30d");
  const { data: curve } = usePnlCurve(range);
  const [closeAll, setCloseAll] = useState(false);
  const release = useAction(api.releaseEstop, { ok: tr("已解除急停，任务对账后恢复", "E-stop released") });
  const closeMut = useAction(api.closeAll, { ok: tr("已提交全部平仓", "Close-all submitted") });

  if (isLoading || !data) return <Loading />;
  const points = curve?.points ?? [];
  const pnl = points.length ? points[points.length - 1][1] : 0;
  const pct = curve && curve.start_equity > 0 ? (pnl / curve.start_equity) * 100 : null;
  const dd = maxDrawdown(points);
  const fid = fidelity(data.tasks);
  const items = attention(data);

  return (
    <div className="flex h-full flex-col">
      {data.estopped ? (
        <div className="anim-fade flex flex-wrap items-center justify-between gap-2 bg-danger-soft px-4 py-3 md:px-6">
          <span className="text-sm text-danger">{tr("全局急停中：所有任务已暂停，镜像挂单已撤销，仓位保持不变。", "E-stop active: all tasks paused, mirrored orders cancelled, positions unchanged.")}</span>
          <div className="flex gap-2">
            <Button size="sm" loading={release.isPending} onClick={() => release.mutate(undefined)}>
              {tr("恢复（先对账）", "Resume (reconcile first)")}
            </Button>
            <Button size="sm" variant="danger" onClick={() => setCloseAll(true)}>
              {tr("全部平仓", "Close all")}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Seg value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: tr(r.zh, r.en) }))} className="max-md:flex-1 max-md:[&>button]:flex-1" />
          <Button variant="primary" className="max-md:hidden" onClick={() => go("wizard")}>
            <Plus size={14} />
            {tr("新建跟单任务", "New copy task")}
          </Button>
        </div>

        <div className="flex gap-4 max-lg:flex-col">
          {/* PnL hero + curve */}
          <section className="min-w-0 flex-1 border border-border bg-card max-md:-mx-4 max-md:border-x-0">
            <div className="px-4 pt-4 md:px-5 md:pt-5">
              <div className="text-xs text-muted-fg">{tr(`${rangeLabel(range)}跟单盈亏（USDT）`, `${rangeLabel(range)} copy PnL (USDT)`)}</div>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <span className={clsx("num text-[34px] leading-tight font-semibold tracking-[-1px] md:text-[44px]", pnlClass(pnl))}>{signed(pnl)}</span>
                {pct != null ? <span className={clsx("num px-1.5 py-0.5 text-xs", pnl >= 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>{signed(pct, 2)}%</span> : null}
              </div>
              <div className="mt-4 grid grid-cols-4 gap-4 max-md:grid-cols-2">
                <Fact label={tr("总权益", "Equity")} value={num(data.total_equity)} />
                <Fact label={tr("今日", "Today")} value={signed(data.today_pnl)} cls={pnlClass(data.today_pnl)} />
                <Fact label={tr("浮动盈亏", "Unrealized")} value={signed(data.upnl)} cls={pnlClass(data.upnl)} />
                <Fact label={tr("跟单还原度", "Copy fidelity")} value={fid != null ? `${num(fid, 1)}%` : "—"} cls={fid != null && fid < 95 ? "text-warning" : undefined} />
              </div>
            </div>
            <div className="mt-3 px-1">
              {points.length > 1 ? (
                <PnlCurveChart points={points} height={240} />
              ) : (
                <div className="flex h-[200px] items-center justify-center text-xs text-muted-fg">{tr("还没有足够的权益快照，运行一段时间后显示盈亏曲线", "Not enough equity snapshots yet; the curve appears after a while")}</div>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-fg md:px-5">
              <span className="max-md:hidden">{tr("按跟单账户权益变化计算，含资金费与手续费", "From follower equity changes, fees and funding included")}</span>
              {dd.dd > 0 ? (
                <span className="text-danger">
                  {tr("最大回撤", "Max DD")} <span className="num">−{num(dd.dd)}</span>
                </span>
              ) : null}
            </div>
          </section>

          {/* Right column */}
          <div className="flex w-[360px] shrink-0 flex-col gap-4 max-lg:w-full">
            <section className="border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">{tr("需要处理", "Needs attention")}</h2>
                {items.length ? <span className="num bg-danger px-1.5 text-xs text-on-danger">{items.length}</span> : null}
              </div>
              {items.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-fg">
                  <Dot color="success" />
                  {tr("一切正常", "All clear")}
                </div>
              ) : (
                items.map((a) => (
                  <button key={a.key} disabled={!a.task} onClick={() => a.task && go("task", a.task)} className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 enabled:hover:bg-muted">
                    <span className={clsx("w-[3px] self-stretch", a.level === "error" ? "bg-danger" : "bg-warning")} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{a.title}</div>
                      <div className="mt-0.5 truncate text-xs text-muted-fg">{a.detail}</div>
                    </div>
                    {a.task ? <ChevronRight size={14} className="shrink-0 text-muted-fg" /> : null}
                  </button>
                ))
              )}
              <button className="w-full border-t border-border py-2 text-xs text-muted-fg hover:text-fg" onClick={() => go("records")}>
                {tr("查看全部记录", "All records")}
              </button>
            </section>

            <section className="border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">{tr("跟单账户", "Follower accounts")}</h2>
                <span className="text-xs text-muted-fg">{tr("权益 / 今日", "Equity / today")}</span>
              </div>
              {data.accounts.length === 0 ? (
                <div className="px-4 py-4 text-sm text-muted-fg">
                  {tr("暂无跟单账户。", "No follower accounts.")}{" "}
                  <Button variant="link" onClick={() => go("connections")}>
                    {tr("添加账户", "Add account")}
                  </Button>
                </div>
              ) : (
                data.accounts.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 border-b border-border px-4 py-2.5 last:border-b-0">
                    <PlatformTag platform={a.platform} />
                    <span className={clsx("min-w-0 flex-1 truncate text-sm", a.platform === "paper" && "text-muted-fg")}>{a.alias}</span>
                    <div className="text-right">
                      <div className="num text-sm">{num(a.equity)}</div>
                      <div className={clsx("num text-xs", pnlClass(a.today_pnl))}>{signed(a.today_pnl)}</div>
                    </div>
                  </div>
                ))
              )}
            </section>
          </div>
        </div>

        <section className="mt-4 border border-border bg-card max-md:-mx-4 max-md:border-x-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{tr("我的持仓", "My positions")}</h2>
            <span className="text-xs text-muted-fg">{tr("全部跟单账户 · 每分钟刷新", "All follower accounts · refreshed every minute")}</span>
          </div>
          <PositionsTable kind="overview" rows={data.positions ?? []} empty={<div className="px-4 py-6 text-sm text-muted-fg">{tr("当前没有持仓", "No open positions")}</div>} />
        </section>

        <Ranking tasks={curve?.tasks ?? []} live={data.tasks} range={range} />

        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{tr("今日执行", "Today")}</h2>
            <span className="text-xs text-muted-fg">{tr("自 00:00 起", "since 00:00")}</span>
          </div>
          <div className="grid grid-cols-5 border border-border bg-card max-md:grid-cols-3">
            <Stat label={tr("收到信号", "Signals")} value={String(data.today.signals)} />
            <Stat label={tr("发出订单", "Orders")} value={String(data.today.orders)} />
            <Stat label={tr("平均滑点", "Avg slippage")} value={data.today.avg_slippage_pct != null ? `${num(data.today.avg_slippage_pct, 2)}%` : "—"} />
            <Stat label={tr("风控跳过", "Skipped")} value={String(data.today.skipped)} />
            <Stat label={tr("下单失败", "Failed")} value={String(data.today.failed)} cls={data.today.failed > 0 ? "text-danger" : undefined} />
          </div>
        </section>
      </div>
      <Confirm
        open={closeAll}
        onClose={() => setCloseAll(false)}
        danger
        word={tr("全部平仓", "CLOSE ALL")}
        busy={closeMut.isPending}
        title={tr("全部平仓", "Close all positions")}
        body={tr("将以市价平掉所有未停止任务的跟单账户上的全部仓位（只减仓）。此操作不可撤销。", "Market-close every position on the follower accounts of all non-stopped tasks (reduce-only). This cannot be undone.")}
        confirmLabel={tr("确认平仓", "Close all")}
        onConfirm={async () => {
          await closeMut.mutateAsync(undefined);
          setCloseAll(false);
        }}
      />
    </div>
  );
}

function Ranking({ tasks, live, range }: { tasks: TaskPnl[]; live: TaskSummary[]; range: PnlRange }) {
  const tr = useTr();
  const { go } = useUi();
  if (tasks.length === 0)
    return (
      <section className="mt-4 border border-border bg-card">
        <Empty
          title={tr("还没有跟单任务", "No copy tasks yet")}
          hint={tr("先在「交易账户」添加跟单账户，在「信号源」添加要跟随的对象，再新建任务。", "Add follower accounts and a source, then create a task.")}
          action={
            <Button variant="primary" onClick={() => go("wizard")}>
              {tr("新建任务", "New task")}
            </Button>
          }
        />
      </section>
    );
  const maxAbs = Math.max(...tasks.map((t) => Math.abs(t.pnl)), 1e-9);
  return (
    <section className="mt-4 border border-border bg-card max-md:-mx-4 max-md:border-x-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{tr("任务盈亏排行", "Task ranking")}</h2>
        <Button variant="link" className="text-xs" onClick={() => go("tasks")}>
          {tr("全部任务", "All tasks")}
        </Button>
      </div>
      <div className="grid grid-cols-[minmax(0,1.6fr)_120px_minmax(0,1fr)_80px_100px_110px_120px] items-center gap-x-4 border-b border-border px-4 py-2 text-xs text-muted-fg max-md:hidden">
        <span>{tr("任务", "Task")}</span>
        <span className="text-right">{tr(`${rangeLabel(range)}盈亏`, `${rangeLabel(range)} PnL`)}</span>
        <span />
        <span className="text-right">ROI</span>
        <span className="text-right">{tr("今日", "Today")}</span>
        <span>{tr("14 天走势", "14 days")}</span>
        <span className="text-right">{tr("状态", "Status")}</span>
      </div>
      {tasks.map((t) => {
        const s = live.find((x) => x.id === t.task_id);
        const roi = t.start_equity > 0 ? (t.pnl / t.start_equity) * 100 : null;
        const today = t.daily.length ? t.daily[t.daily.length - 1][1] : 0;
        const bar = (
          <div className="h-1.5 w-full bg-muted">
            <div className={clsx("h-full", t.pnl >= 0 ? "bg-success" : "bg-danger")} style={{ width: `${(Math.abs(t.pnl) / maxAbs) * 100}%` }} />
          </div>
        );
        return (
          <button key={t.task_id} onClick={() => go("task", t.task_id)} className="grid w-full grid-cols-[minmax(0,1.6fr)_120px_minmax(0,1fr)_80px_100px_110px_120px] items-center gap-x-4 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted max-md:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="min-w-0">
              <div className={clsx("truncate text-sm font-semibold", t.status !== "running" && "text-muted-fg")}>{t.name}</div>
              <div className="truncate text-xs text-muted-fg">{s ? `${sourceLabel(s)} → ${s.followers.map((f) => f.alias).join("、")}` : statusText(t)}</div>
            </div>
            <div className={clsx("num text-right text-sm max-md:col-start-3 max-md:row-start-1", pnlClass(t.pnl))}>
              {signed(t.pnl)}
              <div className="mt-1 hidden w-20 max-md:ml-auto max-md:block">{bar}</div>
            </div>
            <div className="max-md:hidden">{bar}</div>
            <div className={clsx("num text-right text-sm max-md:hidden", pnlClass(roi))}>{roi != null ? `${signed(roi, 1)}%` : "—"}</div>
            <div className={clsx("num text-right text-sm max-md:hidden", pnlClass(today))}>{signed(today)}</div>
            <Spark values={t.daily.map((d) => d[1])} className="max-md:col-start-2 max-md:row-start-1" />
            <div className="text-right text-xs max-md:hidden">
              <StatusText t={t} />
            </div>
          </button>
        );
      })}
    </section>
  );
}

function statusText(t: Pick<TaskPnl, "status" | "pause_reason">) {
  if (t.status === "running") return trNow("运行中", "Running");
  if (t.status === "paused") return t.pause_reason ? trNow(`已暂停：${t.pause_reason}`, `Paused: ${t.pause_reason}`) : trNow("已暂停", "Paused");
  return trNow("已停止", "Stopped");
}

export function StatusText({ t }: { t: Pick<TaskPnl, "status" | "pause_reason"> }) {
  return (
    <span className={clsx("inline-flex max-w-full items-center justify-end gap-1.5", t.status === "running" ? "text-fg" : t.status === "paused" && t.pause_reason ? "text-danger" : "text-muted-fg")} title={statusText(t)}>
      <Dot color={t.status === "running" ? "success" : t.status === "paused" && t.pause_reason ? "danger" : "muted"} />
      <span className="truncate">{statusText(t)}</span>
    </span>
  );
}

function Fact({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-fg">{label}</div>
      <div className={clsx("num mt-1 truncate text-md", cls)}>{value}</div>
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="border-border px-4 py-3 max-md:border-b md:border-r md:last:border-r-0">
      <div className="text-xs text-muted-fg">{label}</div>
      <div className={clsx("num mt-1 text-lg", cls)}>{value}</div>
    </div>
  );
}
