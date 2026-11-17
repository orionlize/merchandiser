import clsx from "clsx";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Confirm, Empty, Loading, Seg, StatusLabel } from "../components/ui";
import { api, type Rules, type TaskSummary } from "../lib/api";
import { date, days, pnlClass, signed } from "../lib/format";
import { trNow, useTr } from "../lib/i18n";
import { useAction, useTasks } from "../lib/queries";
import { useUi } from "../lib/store";
import { sourceLabel } from "./Overview";
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

type Filter = "all" | "running" | "paused" | "stopped";

export function Tasks() {
  const tr = useTr();
  const { go } = useUi();
  const { data, isLoading } = useTasks();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [stopping, setStopping] = useState<TaskSummary | null>(null);
  const [deleting, setDeleting] = useState<TaskSummary | null>(null);
  const action = useAction(({ id, a }: { id: string; a: "start" | "resume" | "pause" }) => api.taskAction(id, a), { invalidate: [["tasks"]] });
  const del = useAction(api.deleteTask, { ok: tr("已删除", "Deleted"), invalidate: [["tasks"]] });

  const tasks = data ?? [];
  const counts = useMemo(() => ({ all: tasks.length, running: tasks.filter((t) => t.status === "running").length, paused: tasks.filter((t) => t.status === "paused").length, stopped: tasks.filter((t) => t.status === "stopped").length }), [tasks]);
  const shown = tasks.filter((t) => (filter === "all" || t.status === filter) && (!q || `${t.name} ${t.source_name} ${t.source_address ?? ""}`.toLowerCase().includes(q.toLowerCase())));

  if (isLoading) return <Loading />;

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 py-6">
      <div className="mb-4 flex items-center gap-4">
        <div className="flex h-8 w-[260px] items-center gap-2 rounded-md border border-input bg-bg px-3 focus-within:border-ring">
          <Search size={14} className="text-muted-fg" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("搜索任务、信号源地址", "Search tasks or source address")} className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-fg" />
        </div>
        <Seg
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `${tr("全部", "All")} ${counts.all}` },
            { value: "running", label: `${tr("运行中", "Running")} ${counts.running}` },
            { value: "paused", label: `${tr("已暂停", "Paused")} ${counts.paused}` },
            { value: "stopped", label: `${tr("已停止", "Stopped")} ${counts.stopped}` },
          ]}
        />
        <div className="flex-1" />
        <Button variant="primary" onClick={() => go("wizard")}>
          <Plus size={14} />
          {tr("新建任务", "New task")}
        </Button>
      </div>
      {tasks.length === 0 ? (
        <div className="rounded-lg border border-border">
          <Empty title={tr("还没有跟单任务", "No tasks yet")} hint={tr("新建向导会依次引导你选择信号源、跟单账户、规则与风控。", "The wizard walks you through source, followers, rules and risk.")} />
        </div>
      ) : (
        <div className="anim-fade overflow-hidden rounded-lg border border-border bg-card" key={filter}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-fg">
                <th className="px-4 py-2.5 font-normal">{tr("任务", "Task")}</th>
                <th className="px-2 font-normal">{tr("信号源", "Source")}</th>
                <th className="px-2 font-normal">{tr("跟单账户", "Followers")}</th>
                <th className="px-2 font-normal">{tr("仓位计算", "Sizing")}</th>
                <th className="px-2 font-normal">{tr("挂单镜像", "Mirroring")}</th>
                <th className="px-2 text-right font-normal">{tr("今日盈亏", "Today")}</th>
                <th className="px-2 text-right font-normal">{tr("累计盈亏", "Total")}</th>
                <th className="px-4 font-normal">{tr("状态", "Status")}</th>
                <th className="px-4 text-right font-normal">{tr("操作", "Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const dim = t.status === "stopped";
                const reconciling = t.status === "running" && Number(t.live?.deviation_pct ?? 0) > Number(t.rules.tolerance_pct);
                const mirrorSupported = t.source_kind !== "lead_trader";
                return (
                  <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="cursor-pointer px-4 py-2.5" onClick={() => go("task", t.id)}>
                      <div className={clsx("font-semibold", dim && "text-muted-fg font-normal")}>{t.name}</div>
                      <div className={clsx("mt-0.5 text-xs", t.status === "paused" && t.pause_reason && t.pause_reason !== "手动暂停" ? "text-danger" : "text-muted-fg")}>
                        {t.status === "stopped"
                          ? `${date(t.stopped_at ?? t.created_at)} ${tr("停止", "stopped")}${t.rules.stop === "keep" ? tr("，仓位已保留", ", positions kept") : ""}`
                          : t.status === "paused" && t.pause_reason && t.pause_reason !== "手动暂停"
                            ? t.pause_reason
                            : `${tr("创建于", "Created")} ${date(t.created_at)}${t.started_at ? tr(`，已运行 ${days(t.started_at)} 天`, `, ${days(t.started_at)}d running`) : ""}`}
                      </div>
                    </td>
                    <td className={clsx("px-2", dim && "text-muted-fg")}>
                      {sourceLabel(t)}
                      {t.source_kind === "api" ? <span className="text-muted-fg">{tr("（只读）", " (read-only)")}</span> : null}
                    </td>
                    <td className={clsx("px-2", dim && "text-muted-fg")}>{followersLabel(t)}</td>
                    <td className={clsx("px-2", dim && "text-muted-fg")}>{sizingLabel(t.rules)}</td>
                    <td className={clsx("px-2", dim && "text-muted-fg")}>{!mirrorSupported ? tr("不支持", "N/A") : t.rules.mirror.enabled ? tr("开", "On") : tr("关", "Off")}</td>
                    <td className={clsx("num px-2 text-right", pnlClass(t.today_pnl))}>{t.status === "stopped" ? "—" : signed(t.today_pnl)}</td>
                    <td className={clsx("num px-2 text-right", pnlClass(t.total_pnl))}>{signed(t.total_pnl)}</td>
                    <td className="px-4">
                      <StatusLabel status={t.status} reconciling={reconciling} />
                    </td>
                    <td className="px-4 text-right whitespace-nowrap">
                      {t.status === "running" ? (
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
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length === 0 ? <div className="py-10 text-center text-sm text-muted-fg">{tr("没有匹配的任务", "No matching tasks")}</div> : null}
        </div>
      )}
      <p className="mt-4 text-xs text-muted-fg">{tr("挂单镜像只对 API 连接的账户与 Hyperliquid 地址生效；交易所带单员只做仓位跟随。", "Order mirroring works for API accounts and Hyperliquid addresses; exchange lead traders are position-follow only.")}</p>
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
