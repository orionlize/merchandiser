import clsx from "clsx";
import { RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Empty, Loading, Modal, Radio, SideTag, Tabs } from "../components/ui";
import { api, type CompareRow, type Mirror, type Risk, type TaskDetail as TD, type TaskSummary } from "../lib/api";
import { ago, num, pnlClass, price, qty, signed, time } from "../lib/format";
import { trNow, useTr } from "../lib/i18n";
import { useAction, useTask } from "../lib/queries";
import { useUi } from "../lib/store";
import { sizingLabel } from "./Tasks";

export function TaskDetail() {
  const tr = useTr();
  const { route, go } = useUi();
  const lang = useUi((s) => s.lang);
  const { data: t, isLoading } = useTask(route.id);
  const [tab, setTab] = useState<"pos" | "mirror" | "log">("pos");
  const [stopping, setStopping] = useState(false);
  const act = useAction(({ a }: { a: "start" | "resume" | "pause" | "reconcile" }) => api.taskAction(route.id!, a), { invalidate: [["task"], ["tasks"]] });

  if (isLoading || !t) return <Loading />;
  const live = t.live;
  const liveMirrors = t.mirrors.filter((m) => m.status !== "done");

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 py-6">
        <div className="flex items-center gap-2 text-xs text-muted-fg">
          <button className="hover:text-fg" onClick={() => go("tasks")}>
            {tr("跟单任务", "Tasks")}
          </button>
          <span>/</span>
          <span className="text-fg">{t.name}</span>
        </div>
        <div className="mt-4 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-3xl font-semibold tracking-[-1px]">{t.name}</h1>
            <StatusPill t={t} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
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

        <div className="mt-5 flex gap-10">
          <Kpi label={tr("累计盈亏 USDT", "Total PnL USDT")} value={signed(t.total_pnl)} cls={pnlClass(t.total_pnl)} big />
          <Kpi label={tr("今日", "Today")} value={signed(t.today_pnl)} big />
          <Kpi label={tr("名义偏差", "Notional gap")} value={live ? `${num(live.deviation_pct, 1)}%` : "—"} big />
          <Kpi label={tr("延迟 P95", "Latency P95")} value={t.latency_p95 != null ? `${t.latency_p95} ms` : "—"} big />
          <Kpi label={tr("上次对账", "Last reconcile")} value={ago(live?.last_reconcile, lang === "en")} big sans />
        </div>

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
        <div key={tab} className="anim-rise mt-4">
          {tab === "pos" ? <PositionCompare rows={live?.rows ?? []} running={t.status === "running"} tolerance={t.rules.tolerance_pct} /> : null}
          {tab === "mirror" ? <Mirrors mirrors={t.mirrors} enabled={t.rules.mirror.enabled} grace={t.rules.mirror.grace_ms} /> : null}
          {tab === "log" ? <SignalLog t={t} /> : null}
        </div>
      </div>
      <RulesPanel t={t} />
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

function Kpi({ label, value, cls, big, sans }: { label: string; value: string; cls?: string; big?: boolean; sans?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-fg">{label}</div>
      <div className={clsx("mt-1", big ? "text-xl" : "text-md", sans ? "" : "num", cls)}>{value}</div>
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
    <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-border px-6 py-6">
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
    </aside>
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
