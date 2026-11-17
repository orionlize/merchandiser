import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Download } from "lucide-react";
import { useState } from "react";
import { dailyFromCurve, DailyBars } from "../components/Charts";
import { Button, Empty, Loading, Seg, Select, Tabs } from "../components/ui";
import { api, errMsg, type LogFilter, type LogRow, type PnlCurve, type PnlRow } from "../lib/api";
import { num, pnlClass, price, qty, signed, time } from "../lib/format";
import { trNow, useTr } from "../lib/i18n";
import { useConnections, usePnlCurve, useSettings, useTasks } from "../lib/queries";
import { downloadText } from "../lib/files";
import { useUi } from "../lib/store";

export function Records() {
  const tr = useTr();
  const initial = useUi((s) => s.route.id);
  const [tab, setTab] = useState<"log" | "fills" | "pnl">(initial === "log" || initial === "fills" ? initial : "pnl");
  const [range, setRange] = useState<LogFilter["range"]>(initial === "log" || initial === "fills" ? "today" : "30d");
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
  const { data: curve } = usePnlCurve(range);

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
    <div className="flex h-full flex-col overflow-y-auto px-4 py-4 md:px-6">
      <Tabs
        value={tab}
        onChange={(t) => {
          setTab(t);
          setLimit(50);
        }}
        tabs={[
          { value: "pnl", label: tr("收益报表", "PnL report") },
          { value: "fills", label: tr("成交记录", "Fills") },
          { value: "log", label: tr("执行日志", "Execution log") },
        ]}
      />
      <div className="mt-4 mb-4 flex flex-wrap items-center gap-2">
        <Select value={range} onChange={setRange} options={rangeOpts} />
        {tab !== "pnl" ? (
          <>
            <Select value={taskId} onChange={setTaskId} options={[{ value: "", label: tr("全部任务", "All tasks") }, ...(tasks ?? []).map((t) => ({ value: t.id, label: t.name }))]} />
            <Select value={connId} onChange={setConnId} options={[{ value: "", label: tr("全部账户", "All accounts") }, ...(conns ?? []).map((c) => ({ value: c.id, label: c.alias }))]} />
          </>
        ) : null}
        {tab === "log" ? (
          <Seg
            className="md:ml-2"
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
            <span className="max-md:hidden">{tr("导出 CSV", "Export CSV")}</span>
          </Button>
        ) : null}
      </div>

      {tab === "pnl" ? (
        pnl.isLoading ? (
          <Loading />
        ) : (
          <>
          <PnlSummary curve={curve} rows={pnl.data ?? []} range={range} />
          <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-fg">
                  <th className="px-4 py-2.5 text-left font-normal">{tr("账户", "Account")}</th>
                  <th className="px-2 text-right font-normal max-md:hidden">{tr("期初权益", "Start equity")}</th>
                  <th className="px-2 text-right font-normal">{tr("期末权益", "End equity")}</th>
                  <th className="px-2 text-right font-normal">{tr("盈亏", "PnL")}</th>
                  <th className="px-2 text-right font-normal max-md:hidden">{tr("成交笔数", "Fills")}</th>
                  <th className="px-4 text-right font-normal max-md:hidden">{tr("成交额", "Volume")}</th>
                </tr>
              </thead>
              <tbody>
                {(pnl.data ?? []).map((r) => (
                  <tr key={r.connection_id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5">{r.alias}</td>
                    <td className="num px-2 text-right max-md:hidden">{num(r.start_equity)}</td>
                    <td className="num px-2 text-right">{num(r.end_equity)}</td>
                    <td className={clsx("num px-2 text-right max-md:pr-4", pnlClass(r.pnl))}>{signed(r.pnl)}</td>
                    <td className="num px-2 text-right max-md:hidden">{r.fills}</td>
                    <td className="num px-4 text-right max-md:hidden">{num(r.volume)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-fg">{tr("盈亏按权益快照差计算（每分钟采样），含资金费与手续费。", "PnL is the change in sampled equity (every minute), fees and funding included.")}</p>
          </>
        )
      ) : logs.isLoading ? (
        <Loading />
      ) : !logs.data?.rows.length ? (
        <div className="rounded-lg border border-border">
          <Empty title={tr("暂无记录", "No records")} />
        </div>
      ) : (
        <>
          <div key={`${tab}-${status}`} className="anim-fade overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[860px] text-sm">
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
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-fg">
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

function PnlSummary({ curve, rows, range }: { curve: PnlCurve | undefined; rows: PnlRow[]; range: LogFilter["range"] }) {
  const tr = useTr();
  const points = curve?.points ?? [];
  const pnl = points.length ? points[points.length - 1][1] : 0;
  const days = dailyFromCurve(points);
  const fills = rows.reduce((a, r) => a + r.fills, 0);
  const volume = rows.reduce((a, r) => a + Number(r.volume || 0), 0);
  const won = days.filter((d) => d[1] > 0).length;
  const label = { today: tr("今日", "Today's"), "7d": tr("近 7 天", "7-day"), "30d": tr("近 30 天", "30-day"), all: tr("累计", "All-time") }[range];
  return (
    <div className="border border-border bg-card max-md:-mx-4 max-md:border-x-0">
      <div className="flex flex-wrap items-end justify-between gap-4 px-4 pt-4 md:px-5">
        <div>
          <div className="text-xs text-muted-fg">{tr(`${label}跟单盈亏（USDT）`, `${label} copy PnL (USDT)`)}</div>
          <div className={clsx("num mt-1 text-[32px] leading-tight font-semibold", pnlClass(pnl))}>{signed(pnl)}</div>
          {curve && curve.start_equity > 0 ? (
            <div className="num mt-1 text-xs text-muted-fg">
              {tr("期初", "Start")} {num(curve.start_equity)} → {tr("期末", "end")} {num(curve.start_equity + pnl)}
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-6">
          <div>
            <div className="text-xs text-muted-fg">{tr("成交笔数", "Fills")}</div>
            <div className="num mt-1 text-lg">{fills}</div>
          </div>
          <div>
            <div className="text-xs text-muted-fg">{tr("成交额", "Volume")}</div>
            <div className="num mt-1 text-lg">{compact(volume)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-fg">{tr("盈利天数", "Green days")}</div>
            <div className="num mt-1 text-lg">
              {won} / {days.length}
            </div>
          </div>
        </div>
      </div>
      <div className="px-4 pt-4 pb-3 md:px-5">
        {days.length > 1 ? <DailyBars days={days} height={110} /> : <div className="flex h-[60px] items-center text-xs text-muted-fg">{tr("区间内不足两天的权益数据，暂不显示每日柱状图", "Daily bars appear once the range spans two days of equity data")}</div>}
        {days.length > 1 ? (
          <div className="num mt-1.5 flex justify-between text-xs text-muted-fg">
            <span>{new Date(days[0][0]).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })}</span>
            <span>{tr("每日盈亏，最后一根为今日", "Daily PnL; the last bar is today")}</span>
            <span>{new Date(days[days.length - 1][0]).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function compact(v: number) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${num(v / 1e9, 2)}B`;
  if (a >= 1e6) return `${num(v / 1e6, 2)}M`;
  if (a >= 1e4) return `${num(v / 1e3, 1)}K`;
  return num(v, 0);
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
