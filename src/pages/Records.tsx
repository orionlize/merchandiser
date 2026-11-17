import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Download } from "lucide-react";
import { useState } from "react";
import { Button, Empty, Loading, Seg, Select, Tabs } from "../components/ui";
import { api, errMsg, type LogFilter, type LogRow } from "../lib/api";
import { num, pnlClass, price, qty, signed, time } from "../lib/format";
import { trNow, useTr } from "../lib/i18n";
import { useConnections, useSettings, useTasks } from "../lib/queries";
import { downloadText } from "../lib/files";
import { useUi } from "../lib/store";

export function Records() {
  const tr = useTr();
  const [tab, setTab] = useState<"log" | "fills" | "pnl">("log");
  const [range, setRange] = useState<LogFilter["range"]>("today");
  const [taskId, setTaskId] = useState("");
  const [connId, setConnId] = useState("");
  const [status, setStatus] = useState<"all" | "skipped" | "failed">("all");
  const [limit, setLimit] = useState(50);
  const toast = useUi((s) => s.toast);
  const { data: tasks } = useTasks();
  const { data: conns } = useConnections();
  const { data: settings } = useSettings();

  const filter: LogFilter = { range, task_id: taskId || null, connection_id: connId || null, status: tab === "log" ? status : "all", fills_only: tab === "fills", limit };
  const logs = useQuery({ queryKey: ["logs", filter], queryFn: () => api.logs(filter), enabled: tab !== "pnl", refetchInterval: 10000 });
  const pnl = useQuery({ queryKey: ["pnl", range], queryFn: () => api.pnl(range), enabled: tab === "pnl" });

  const exportCsv = async () => {
    try {
      const { csv, rows } = await api.exportCsv({ ...filter, limit: undefined });
      downloadText(`merchandiser-${tab}-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
      toast(tr(`已导出 ${rows} 条`, `Exported ${rows} rows`));
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const rangeOpts = [
    { value: "today" as const, label: tr("今日", "Today") },
    { value: "7d" as const, label: tr("近 7 天", "7 days") },
    { value: "30d" as const, label: tr("近 30 天", "30 days") },
    { value: "all" as const, label: tr("全部", "All") },
  ];

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 py-4">
      <Tabs
        value={tab}
        onChange={(t) => {
          setTab(t);
          setLimit(50);
        }}
        tabs={[
          { value: "log", label: tr("执行日志", "Execution log") },
          { value: "fills", label: tr("成交记录", "Fills") },
          { value: "pnl", label: tr("收益报表", "PnL report") },
        ]}
      />
      <div className="mt-4 mb-4 flex items-center gap-2">
        <Select value={range} onChange={setRange} options={rangeOpts} />
        {tab !== "pnl" ? (
          <>
            <Select value={taskId} onChange={setTaskId} options={[{ value: "", label: tr("全部任务", "All tasks") }, ...(tasks ?? []).map((t) => ({ value: t.id, label: t.name }))]} />
            <Select value={connId} onChange={setConnId} options={[{ value: "", label: tr("全部账户", "All accounts") }, ...(conns ?? []).map((c) => ({ value: c.id, label: c.alias }))]} />
          </>
        ) : null}
        {tab === "log" ? (
          <Seg
            className="ml-2"
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: tr("全部", "All") },
              { value: "skipped", label: `${tr("跳过", "Skipped")} ${logs.data?.skipped ?? ""}` },
              { value: "failed", label: `${tr("失败", "Failed")} ${logs.data?.failed ?? ""}` },
            ]}
          />
        ) : null}
        <div className="flex-1" />
        {tab !== "pnl" ? (
          <Button onClick={exportCsv}>
            <Download size={14} />
            {tr("导出 CSV", "Export CSV")}
          </Button>
        ) : null}
      </div>

      {tab === "pnl" ? (
        pnl.isLoading ? (
          <Loading />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-fg">
                  <th className="px-4 py-2.5 text-left font-normal">{tr("账户", "Account")}</th>
                  <th className="px-2 text-right font-normal">{tr("期初权益", "Start equity")}</th>
                  <th className="px-2 text-right font-normal">{tr("期末权益", "End equity")}</th>
                  <th className="px-2 text-right font-normal">{tr("盈亏", "PnL")}</th>
                  <th className="px-2 text-right font-normal">{tr("成交笔数", "Fills")}</th>
                  <th className="px-4 text-right font-normal">{tr("成交额", "Volume")}</th>
                </tr>
              </thead>
              <tbody>
                {(pnl.data ?? []).map((r) => (
                  <tr key={r.connection_id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5">{r.alias}</td>
                    <td className="num px-2 text-right">{num(r.start_equity)}</td>
                    <td className="num px-2 text-right">{num(r.end_equity)}</td>
                    <td className={clsx("num px-2 text-right", pnlClass(r.pnl))}>{signed(r.pnl)}</td>
                    <td className="num px-2 text-right">{r.fills}</td>
                    <td className="num px-4 text-right">{num(r.volume)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-border px-4 py-3 text-xs text-muted-fg">{tr("盈亏按权益快照差计算（每分钟采样），含资金费与手续费；分项拆分与跟踪误差将在第二期提供。", "PnL is the change in sampled equity (every minute), fees and funding included. Breakdown and tracking error arrive in phase 2.")}</p>
          </div>
        )
      ) : logs.isLoading ? (
        <Loading />
      ) : !logs.data?.rows.length ? (
        <div className="rounded-lg border border-border">
          <Empty title={tr("暂无记录", "No records")} />
        </div>
      ) : (
        <>
          <div key={`${tab}-${status}`} className="anim-fade overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-fg">
                  <th className="px-4 py-2.5 font-normal">{tr("时间", "Time")}</th>
                  <th className="px-2 font-normal">{tr("任务", "Task")}</th>
                  <th className="px-2 font-normal">{tr("信号", "Signal")}</th>
                  <th className="px-2 font-normal">{tr("跟单账户", "Account")}</th>
                  <th className="px-2 font-normal">{tr("订单", "Order")}</th>
                  <th className="px-2 text-right font-normal">{tr("成交价", "Fill")}</th>
                  <th className="px-2 text-right font-normal">{tr("滑点", "Slip")}</th>
                  <th className="px-2 text-right font-normal">{tr("耗时", "Time")}</th>
                  <th className="px-4 text-right font-normal">{tr("结果", "Result")}</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.rows.map((r) => (
                  <tr key={r.id} className={clsx("border-b border-border last:border-0", r.status === "failed" && "bg-danger-soft")}>
                    <td className="num px-4 py-2.5 text-xs text-muted-fg">{time(r.ts, true)}</td>
                    <td className="px-2">{r.task_name ?? "—"}</td>
                    <td className="max-w-[220px] truncate px-2" title={r.signal_text ?? undefined}>
                      {signalShort(r)}
                    </td>
                    <td className="px-2">{r.alias ?? "—"}</td>
                    <td className="px-2">{orderDesc(r)}</td>
                    <td className="num px-2 text-right">{price(r.fill_px)}</td>
                    <td className={clsx("num px-2 text-right", Number(r.slippage_bps) > 30 && "text-warning")}>{r.slippage_bps != null ? `${num(Number(r.slippage_bps) / 100, 2)}%` : "—"}</td>
                    <td className="num px-2 text-right">{r.latency_ms != null ? (r.latency_ms >= 1000 ? `${(r.latency_ms / 1000).toFixed(1)} s` : `${r.latency_ms} ms`) : "—"}</td>
                    <td className={clsx("max-w-[260px] truncate px-4 text-right text-xs", r.status === "failed" ? "text-danger" : r.status === "skipped" ? "text-warning" : "text-muted-fg")} title={r.reason ?? undefined}>
                      {resultText(r)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-fg">
            <span>{tr(`共 ${logs.data.total} 条，当前显示 ${logs.data.rows.length} 条。日志本地保留 ${settings?.log_retention_days ?? 90} 天，可在设置中修改。`, `${logs.data.total} rows, showing ${logs.data.rows.length}. Logs are kept ${settings?.log_retention_days ?? 90} days (configurable).`)}</span>
            {logs.data.rows.length < logs.data.total ? (
              <Button variant="link" className="text-sm" onClick={() => setLimit((l) => l + 50)}>
                {tr("加载更多", "Load more")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function signalShort(r: LogRow) {
  if (r.signal_text) return r.signal_text.replace(/（.*）$/, "");
  if (r.purpose === "reconcile") return trNow(`${r.base} 对账补单`, `${r.base} reconcile`);
  if (r.purpose === "mirror") return trNow(`${r.base} 挂单镜像`, `${r.base} mirror`);
  if (r.purpose === "close") return trNow(`${r.base} 平仓`, `${r.base} close`);
  return r.base;
}

function orderDesc(r: LogRow) {
  if (r.status === "skipped" || !r.qty) return "—";
  const side = r.buy ? trNow("买", "buy") : trNow("卖", "sell");
  const type = r.order_type === "market" ? trNow("市价", "Market ") : r.order_type === "limit_ioc" ? "IOC " : r.order_type === "limit" ? trNow("限价", "Limit ") : r.order_type === "stop" ? trNow("止损", "Stop ") : r.order_type === "take_profit" ? trNow("止盈", "TP ") : "";
  return `${type}${side} ${qty(r.qty)}${r.reduce_only ? trNow(" 只减", " RO") : ""}`;
}

function resultText(r: LogRow) {
  switch (r.status) {
    case "filled":
      return r.reduce_only && r.purpose === "sync" ? trNow("成交，平仓优先", "Filled, close first") : trNow("成交", "Filled");
    case "partial":
      return r.reason ?? trNow("部分成交", "Partial");
    case "open":
      return r.reason ?? trNow("已挂单", "Resting");
    case "skipped":
      return `${trNow("跳过", "Skipped")}：${r.reason ?? ""}`;
    case "failed":
      return `${trNow("失败", "Failed")}：${r.reason ?? ""}`;
    default:
      return r.status;
  }
}
