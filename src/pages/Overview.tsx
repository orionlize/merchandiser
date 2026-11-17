import clsx from "clsx";
import { AlertTriangle, Check, Info, Pause, Play } from "lucide-react";
import { useState } from "react";
import { DeviationBar, Legend } from "../components/Shell";
import { Button, Confirm, Dot, Empty, IconButton, Loading, PlatformTag } from "../components/ui";
import { api, type TaskSummary } from "../lib/api";
import { num, pnlClass, shortAddr, signed, time } from "../lib/format";
import { useTr } from "../lib/i18n";
import { useAction, useOverview } from "../lib/queries";
import { useUi } from "../lib/store";

export function sourceLabel(t: Pick<TaskSummary, "source_kind" | "source_name" | "source_address" | "source_platform">) {
  if (t.source_kind === "hl_address") return `HL ${shortAddr(t.source_address)}`;
  return t.source_name;
}

export function Overview() {
  const tr = useTr();
  const { go } = useUi();
  const { data, isLoading } = useOverview();
  const [closeAll, setCloseAll] = useState(false);
  const release = useAction(api.releaseEstop, { ok: tr("已解除急停，任务对账后恢复", "E-stop released") });
  const closeMut = useAction(api.closeAll, { ok: tr("已提交全部平仓", "Close-all submitted") });
  const pause = useAction((id: string) => api.taskAction(id, "pause"), { invalidate: [["overview"]] });
  const resume = useAction((id: string) => api.taskAction(id, "resume"), { invalidate: [["overview"]] });

  if (isLoading || !data) return <Loading />;
  const pnlPct = Number(data.today_pnl_pct);

  return (
    <div className="flex h-full flex-col">
      {data.estopped ? (
        <div className="anim-fade flex items-center justify-between bg-danger-soft px-6 py-3">
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
      <div className="flex min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-6">
        <div className="flex min-w-0 flex-1 flex-col gap-8">
          {/* Hero */}
          <section>
            <div className="text-xs text-muted-fg">{tr(`总权益（USDT，${data.follower_count} 个跟单账户合计）`, `Total equity (USDT, ${data.follower_count} follower accounts)`)}</div>
            <div className="num mt-2 text-[56px] leading-[1.05] font-semibold tracking-[-2px] selectable">{num(data.total_equity)}</div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className={clsx("num text-lg", pnlClass(data.today_pnl))}>{signed(data.today_pnl)}</span>
              <span className={clsx("text-xs", pnlClass(data.today_pnl))}>
                {signed(pnlPct, 2)}% {tr("今日", "today")}
              </span>
            </div>
            <div className="mt-6 flex gap-8">
              <Fact label={tr("浮动盈亏", "Unrealised PnL")} value={signed(data.upnl)} cls={pnlClass(data.upnl)} />
              <Fact label={tr("可用保证金", "Available margin")} value={num(data.available)} />
              <Fact label={tr("名义仓位", "Notional")} value={num(data.notional)} />
              <Fact label={tr("信号→下单 P95", "Signal→order P95")} value={data.latency_p95 != null ? `${data.latency_p95} ms` : "—"} />
            </div>
          </section>

          {/* Running tasks */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-md font-semibold">{tr("运行中的任务", "Active tasks")}</h2>
              <div className="flex items-center gap-6">
                <Legend />
                <Button variant="link" className="text-xs" onClick={() => go("tasks")}>
                  {tr("全部任务", "All tasks")}
                </Button>
              </div>
            </div>
            {data.tasks.length === 0 ? (
              <div className="rounded-lg border border-border">
                <Empty
                  title={tr("还没有跟单任务", "No copy tasks yet")}
                  hint={tr("先在「连接」添加跟单账户，在「信号源」添加要跟随的对象，再新建任务。", "Add follower accounts under Connections and a source under Sources, then create a task.")}
                  action={
                    <Button variant="primary" onClick={() => go("wizard")}>
                      {tr("新建任务", "New task")}
                    </Button>
                  }
                />
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                {data.tasks.map((t, i) => {
                  const live = t.live;
                  const dev = Number(live?.deviation_pct ?? 0);
                  const reconciling = t.status === "running" && dev > Number(t.rules.tolerance_pct);
                  return (
                    <div key={t.id} className={clsx("flex items-center gap-4 px-4 py-3.5 hover:bg-muted/40", i > 0 && "border-t border-border")}>
                      <button className="min-w-0 flex-1 text-left" onClick={() => go("task", t.id)}>
                        <div className={clsx("truncate text-sm font-semibold", t.status !== "running" && "text-muted-fg")}>{t.name}</div>
                        <div className="mt-0.5 truncate text-xs text-muted-fg">
                          {sourceLabel(t)} → {t.followers.length} {tr("个账户", "accounts")}
                        </div>
                      </button>
                      <div className="w-[300px] shrink-0">
                        {t.status === "paused" && t.pause_reason ? (
                          <span className="text-xs text-muted-fg">{t.pause_reason}</span>
                        ) : live ? (
                          <div className="flex items-center gap-4">
                            <DeviationBar src={Number(live.target_notional)} target={Number(live.target_notional)} actual={Number(live.actual_notional)} />
                            <span className={clsx("w-24 text-right text-xs", reconciling ? "text-warning" : "text-muted-fg")}>
                              {tr("偏差", "Gap")} {num(dev, 1)}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-fg">—</span>
                        )}
                      </div>
                      <span className={clsx("num w-28 shrink-0 text-right text-sm", pnlClass(t.today_pnl))}>{signed(t.today_pnl)}</span>
                      <span className="w-20 shrink-0">
                        <StatusInline t={t} reconciling={reconciling} />
                      </span>
                      {t.status === "running" ? (
                        <IconButton title={tr("暂停", "Pause")} onClick={() => pause.mutate(t.id)}>
                          <Pause size={12} />
                        </IconButton>
                      ) : (
                        <IconButton title={tr("恢复", "Resume")} onClick={() => resume.mutate(t.id)}>
                          <Play size={12} />
                        </IconButton>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Today */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-md font-semibold">{tr("今日执行", "Today")}</h2>
              <span className="text-xs text-muted-fg">{tr("自 00:00 起", "since 00:00")}</span>
            </div>
            <div className="grid grid-cols-5 border-y border-border">
              <Stat label={tr("收到信号", "Signals")} value={String(data.today.signals)} />
              <Stat label={tr("发出订单", "Orders")} value={String(data.today.orders)} />
              <Stat label={tr("平均滑点", "Avg slippage")} value={data.today.avg_slippage_pct != null ? `${num(data.today.avg_slippage_pct, 2)}%` : "—"} />
              <Stat label={tr("风控跳过", "Skipped")} value={String(data.today.skipped)} />
              <Stat label={tr("下单失败", "Failed")} value={String(data.today.failed)} cls={data.today.failed > 0 ? "text-danger" : undefined} last />
            </div>
          </section>
        </div>

        {/* Right column */}
        <div className="flex w-[380px] shrink-0 flex-col gap-8">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-md font-semibold">{tr("账户权益", "Account equity")}</h2>
              <span className="text-xs text-muted-fg">{tr("今日盈亏", "Today")}</span>
            </div>
            {data.accounts.length === 0 ? (
              <div className="text-sm text-muted-fg">
                {tr("暂无跟单账户。", "No follower accounts.")}{" "}
                <Button variant="link" onClick={() => go("connections")}>
                  {tr("添加连接", "Add connection")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col">
                {data.accounts.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 border-b border-border py-2.5">
                    <PlatformTag platform={a.platform} />
                    <span className={clsx("min-w-0 flex-1 truncate text-sm", a.platform === "paper" && "text-muted-fg")}>{a.alias}</span>
                    <span className={clsx("num w-28 text-right text-sm", a.platform === "paper" && "text-muted-fg")}>{num(a.equity)}</span>
                    <span className={clsx("num w-24 text-right text-sm", pnlClass(a.today_pnl))}>{signed(a.today_pnl)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-md font-semibold">{tr("最近告警", "Recent alerts")}</h2>
              <Button variant="link" className="text-xs" onClick={() => go("records")}>
                {tr("查看记录", "View records")}
              </Button>
            </div>
            {data.alerts.length === 0 ? (
              <div className="text-sm text-muted-fg">{tr("暂无告警", "No alerts")}</div>
            ) : (
              <div className="flex flex-col gap-1">
                {data.alerts.map((a) => (
                  <div key={a.id} className={clsx("flex gap-2 rounded-md px-2 py-2.5", a.level === "error" && "bg-danger-soft")}>
                    <span className="mt-0.5 shrink-0">
                      {a.level === "ok" ? <Check size={14} className="text-success" /> : a.level === "info" ? <Info size={14} className="text-muted-fg" /> : <AlertTriangle size={14} className={a.level === "error" ? "text-danger" : "text-warning"} />}
                    </span>
                    <div className="min-w-0">
                      <div className={clsx("text-sm", a.level === "error" && "text-danger")}>{a.title}</div>
                      <div className="mt-0.5 text-xs text-muted-fg">
                        <span className="num">{time(a.ts)}</span> {a.detail}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
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

function StatusInline({ t, reconciling }: { t: TaskSummary; reconciling: boolean }) {
  const tr = useTr();
  if (t.status === "running")
    return (
      <span className={clsx("inline-flex items-center gap-1.5 text-xs", reconciling && "text-warning")}>
        <Dot color={reconciling ? "warning" : "success"} />
        {reconciling ? tr("对账中", "Reconciling") : tr("运行中", "Running")}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-fg">
      <Dot color="muted" />
      {t.status === "paused" ? tr("已暂停", "Paused") : tr("已停止", "Stopped")}
    </span>
  );
}

function Fact({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-fg">{label}</div>
      <div className={clsx("num mt-1 text-sm", cls)}>{value}</div>
    </div>
  );
}

function Stat({ label, value, cls, last }: { label: string; value: string; cls?: string; last?: boolean }) {
  return (
    <div className={clsx("px-0 py-4", !last && "border-r border-border", "pl-4 first:pl-0")}>
      <div className="text-xs text-muted-fg">{label}</div>
      <div className={clsx("num mt-2 text-xl", cls)}>{value}</div>
    </div>
  );
}
