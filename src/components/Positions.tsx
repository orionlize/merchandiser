import clsx from "clsx";
import type { ReactNode } from "react";
import type { OverviewPosition, PositionLive } from "../lib/api";
import { num, pnlClass, price, qty, signed } from "../lib/format";
import { useTr } from "../lib/i18n";
import { useUi } from "../lib/store";
import { PlatformTag } from "./ui";

/** Totals across a position list: notional, margin, unrealized PnL, ROE on margin. */
export function positionTotals(rows: PositionLive[]) {
  let notional = 0,
    margin = 0,
    upnl = 0,
    marginKnown = true;
  for (const p of rows) {
    notional += Number(p.notional) || 0;
    upnl += Number(p.upnl) || 0;
    if (p.margin != null) margin += Number(p.margin) || 0;
    else marginKnown = false;
  }
  return { notional, margin: marginKnown ? margin : null, upnl, roe: marginKnown && margin > 0 ? (upnl / margin) * 100 : null };
}

function lev(v: string | null | undefined) {
  if (v == null) return "—";
  const n = Number(v);
  return `${Number.isInteger(n) ? n : num(n, 1)}x`;
}

function Side({ size }: { size: string }) {
  const tr = useTr();
  const long = Number(size) > 0;
  return (
    <span className={clsx("inline-flex h-5 items-center px-1.5 text-xs whitespace-nowrap", long ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
      {long ? tr("多", "Long") : tr("空", "Short")}
    </span>
  );
}

function Pnl({ p }: { p: PositionLive }) {
  return (
    <div className={clsx("num text-right", pnlClass(p.upnl))}>
      <div>{signed(p.upnl)}</div>
      <div className="text-xs">{p.roe_pct != null ? `${signed(p.roe_pct, 2)}%` : p.pnl_pct != null ? `${signed(p.pnl_pct, 2)}%` : ""}</div>
    </div>
  );
}

type Mode = { kind: "overview"; rows: OverviewPosition[] } | { kind: "task"; rows: PositionLive[] };

/**
 * Open positions with entry, mark, leverage, margin and PnL. The overview
 * variant lists every follower account and the tasks managing each coin; the
 * task variant adds the source's position in the same coin.
 */
export function PositionsTable(props: Mode & { empty: ReactNode }) {
  const tr = useTr();
  const { go } = useUi();
  const rows = props.rows;
  if (rows.length === 0) return <>{props.empty}</>;
  const overview = props.kind === "overview";
  const tot = positionTotals(rows);

  return (
    <>
      {/* Desktop table */}
      <div className="overflow-x-auto max-md:hidden">
        <table className="w-full min-w-[900px] text-sm whitespace-nowrap [&_td:not(:first-child)]:pl-3 [&_th:not(:first-child)]:pl-3">
          <thead>
            <tr className="border-b border-border text-xs text-muted-fg">
              <th className="py-2 pl-4 text-left font-normal">{tr("品种", "Coin")}</th>
              <th className="text-left font-normal">{tr("账户", "Account")}</th>
              <th className="text-right font-normal">{tr("数量", "Size")}</th>
              <th className="text-right font-normal">{tr("杠杆", "Lev.")}</th>
              <th className="text-right font-normal">{tr("持仓均价", "Avg entry")}</th>
              <th className="text-right font-normal">{tr("标记价", "Mark")}</th>
              <th className="text-right font-normal">{tr("名义价值", "Notional")}</th>
              <th className="text-right font-normal">{tr("保证金", "Margin")}</th>
              <th className="text-right font-normal">{tr("浮动盈亏 / ROE", "uPnL / ROE")}</th>
              {overview ? <th className="pr-4 pl-6 text-left font-normal">{tr("跟单任务", "Tasks")}</th> : <th className="pr-4 pl-6 text-left font-normal">{tr("信号源", "Source")}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={`${p.connection_id}-${p.symbol || p.base}`} className="border-b border-border last:border-b-0">
                <td className="py-2.5 pl-4">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{p.base}</span>
                    <Side size={p.size} />
                  </div>
                </td>
                <td>
                  <div className="flex items-center gap-1.5">
                    {overview ? <PlatformTag platform={(p as OverviewPosition).platform} testnet={(p as OverviewPosition).testnet} /> : null}
                    <span className="truncate">{p.alias}</span>
                  </div>
                </td>
                <td className={clsx("num text-right", Number(p.size) > 0 ? "text-success" : "text-danger")}>{qty(p.size)}</td>
                <td className="num text-right">{lev(p.leverage)}</td>
                <td className="num text-right text-[var(--chart-avg)]">{price(p.entry_px)}</td>
                <td className="num text-right">{price(p.mark_px)}</td>
                <td className="num text-right">{num(p.notional)}</td>
                <td className="num text-right text-muted-fg">{p.margin != null ? num(p.margin) : "—"}</td>
                <td>
                  <Pnl p={p} />
                </td>
                {overview ? (
                  <td className="pr-4 pl-6">
                    <TaskLinks tasks={(p as OverviewPosition).tasks} go={(id) => go("task", id)} />
                  </td>
                ) : (
                  <td className="pr-4 pl-6 text-xs text-muted-fg">
                    <SourceCell p={p} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border text-xs text-muted-fg">
              <td className="py-2 pl-4" colSpan={6}>
                {tr(`共 ${rows.length} 个仓位`, `${rows.length} positions`)}
              </td>
              <td className="num text-right text-fg">{num(tot.notional)}</td>
              <td className="num text-right">{tot.margin != null ? num(tot.margin) : "—"}</td>
              <td className={clsx("num text-right", pnlClass(tot.upnl))}>
                {signed(tot.upnl)}
                {tot.roe != null ? <span className="ml-1">{signed(tot.roe, 2)}%</span> : null}
              </td>
              <td className="pr-4" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden">
        {rows.map((p) => (
          <div key={`${p.connection_id}-${p.symbol || p.base}`} className="border-b border-border px-4 py-3 last:border-b-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-semibold">{p.base}</span>
                <Side size={p.size} />
                <span className="truncate text-xs text-muted-fg">{p.alias}</span>
              </div>
              <Pnl p={p} />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2 text-xs">
              <Cell label={tr("数量", "Size")} value={qty(p.size)} />
              <Cell label={tr("持仓均价", "Avg entry")} value={price(p.entry_px)} cls="text-[var(--chart-avg)]" />
              <Cell label={tr("标记价", "Mark")} value={price(p.mark_px)} />
              <Cell label={tr("名义价值", "Notional")} value={num(p.notional)} />
              <Cell label={tr("保证金", "Margin")} value={p.margin != null ? num(p.margin) : "—"} />
              <Cell label={tr("杠杆", "Leverage")} value={lev(p.leverage)} />
            </div>
            {overview && (p as OverviewPosition).tasks.length ? (
              <div className="mt-2 text-xs">
                <TaskLinks tasks={(p as OverviewPosition).tasks} go={(id) => go("task", id)} />
              </div>
            ) : null}
            {!overview && p.src_size ? (
              <div className="mt-2 text-xs text-muted-fg">
                {tr("信号源", "Source")} <SourceCell p={p} />
              </div>
            ) : null}
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-fg">
          <span>
            {tr("名义", "Notional")} <span className="num text-fg">{num(tot.notional)}</span>
          </span>
          <span className={clsx("num", pnlClass(tot.upnl))}>
            {signed(tot.upnl)}
            {tot.roe != null ? ` (${signed(tot.roe, 2)}%)` : ""}
          </span>
        </div>
      </div>
    </>
  );
}

function Cell({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-fg">{label}</div>
      <div className={clsx("num mt-0.5 truncate", cls)}>{value}</div>
    </div>
  );
}

function SourceCell({ p }: { p: PositionLive }) {
  const tr = useTr();
  if (!p.src_size || Number(p.src_size) === 0) return <span>{tr("已平仓", "Flat")}</span>;
  return (
    <span className="num whitespace-nowrap">
      {qty(p.src_size)} @ {price(p.src_entry_px)}
      {p.src_leverage ? ` · ${lev(p.src_leverage)}` : ""}
    </span>
  );
}

function TaskLinks({ tasks, go }: { tasks: { id: string; name: string }[]; go: (id: string) => void }) {
  const tr = useTr();
  if (!tasks.length) return <span className="text-xs text-muted-fg">{tr("非跟单仓位", "Not copied")}</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {tasks.map((t) => (
        <button key={t.id} onClick={() => go(t.id)} className="truncate text-xs text-primary hover:underline">
          {t.name}
        </button>
      ))}
    </span>
  );
}
