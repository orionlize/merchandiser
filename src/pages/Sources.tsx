import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronLeft, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Confirm, Dot, Empty, Field, Input, Loading, Modal, PlatformTag, Seg, SideTag, Toggle } from "../components/ui";
import { LeadPollSwitch, leadPollOf, useLeadPollText } from "../components/LeadPoll";
import { api, errMsg, type LeadOrder, type LeadPoll, type LeadProbe, type LeadSummary, type Platform, type Source } from "../lib/api";
import { ago, num, pnlClass, price, qty, shortAddr, signed } from "../lib/format";
import { useTr } from "../lib/i18n";
import { useAction, useConnections, useSources } from "../lib/queries";
import { useUi } from "../lib/store";

export function Sources() {
  const tr = useTr();
  const { data: sources, isLoading } = useSources();
  const [sel, setSel] = useState<string | null>(null);
  const [addHl, setAddHl] = useState(false);
  const [addApi, setAddApi] = useState(false);
  const [addLead, setAddLead] = useState(false);
  // Phones show the list or one source, not both.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!sel && sources?.length) setSel(sources[0].id);
  }, [sources, sel]);

  if (isLoading) return <Loading />;
  const groups: [string, Source[]][] = [
    [tr("Hyperliquid 地址", "Hyperliquid addresses"), (sources ?? []).filter((s) => s.kind === "hl_address")],
    [tr("只读 API 账户", "Read-only API accounts"), (sources ?? []).filter((s) => s.kind === "api" && s.platform !== "paper")],
    [tr("模拟账户", "Paper accounts"), (sources ?? []).filter((s) => s.kind === "api" && s.platform === "paper")],
    [tr("交易所带单员", "Exchange lead traders"), (sources ?? []).filter((s) => s.kind === "lead_trader")],
  ];
  const current = sources?.find((s) => s.id === sel);

  return (
    <div className="flex h-full min-h-0">
      <div className={clsx("flex w-[340px] shrink-0 flex-col border-r border-border max-md:w-full max-md:border-r-0", open && "max-md:hidden")}>
        <div className="grid grid-cols-3 gap-2 p-4">
          <Button onClick={() => setAddApi(true)}>
            <Plus size={14} />
            {tr("API 信号源", "API source")}
          </Button>
          <Button onClick={() => setAddHl(true)}>
            <Plus size={14} />
            {tr("HL 地址", "HL address")}
          </Button>
          <Button onClick={() => setAddLead(true)}>
            <Plus size={14} />
            {tr("带单员", "Lead trader")}
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {groups.map(([label, list]) => (
            <div key={label} className="mb-2">
              <div className="px-4 pt-3 pb-2 text-xs text-muted-fg">{label}</div>
              {list.length === 0 ? <div className="px-4 pb-2 text-xs text-muted-fg">—</div> : null}
              {list.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSel(s.id);
                    setOpen(true);
                  }}
                  className={clsx("relative flex w-full items-start justify-between px-4 py-3 text-left transition-colors duration-150 max-md:border-b max-md:border-border", sel === s.id ? "md:bg-muted" : "hover:bg-muted/50")}
                >
                  {sel === s.id ? <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-primary max-md:hidden" /> : null}
                  <div className="min-w-0">
                    <div className="text-sm">{s.name}</div>
                    <div className="num mt-0.5 truncate text-xs text-muted-fg">{s.kind === "hl_address" ? shortAddr(s.address) : s.kind === "lead_trader" ? `${leadVenue(s.platform)} · ${s.address ?? ""}` : `${s.connection_alias ?? ""} · ${s.platform === "paper" ? tr("模拟", "paper") : s.platform}`}</div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-fg">
                    {s.testnet ? <div className="text-primary">{tr("测试网", "Testnet")}</div> : null}
                    {s.lead_mode === "fills" ? <div className="text-warning">{tr("成交推算", "From fills")}{leadPollOf(s) === "trigger" ? tr(" · 动作触发", " · on activity") : ""}</div> : null}
                    <div className="mt-0.5">{tr(`${s.task_count} 个任务`, `${s.task_count} tasks`)}</div>
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={clsx("min-w-0 flex-1 overflow-y-auto", !open && "max-md:hidden")}>
        <button className="flex items-center gap-1 px-4 pt-3 text-sm text-muted-fg md:hidden" onClick={() => setOpen(false)}>
          <ChevronLeft size={16} />
          {tr("全部信号源", "All sources")}
        </button>
        {current ? (
          <SourceDetailView
            key={current.id}
            s={current}
            onDeleted={() => {
              setSel(null);
              setOpen(false);
            }}
          />
        ) : <Empty title={tr("还没有信号源", "No sources yet")} hint={tr("添加任意 Hyperliquid 地址（无需凭证）、OKX / 币安跟单广场的带单员，或用只读 API 连接、模拟账户作为信号源。", "Add any Hyperliquid address (no credentials needed), an OKX / Binance lead trader, or use a read-only API connection or a paper account.")} />}
      </div>
      <AddHlModal open={addHl} onClose={() => setAddHl(false)} onAdded={setSel} />
      <AddApiModal open={addApi} onClose={() => setAddApi(false)} onAdded={setSel} />
      <AddLeadModal open={addLead} onClose={() => setAddLead(false)} onAdded={setSel} />
    </div>
  );
}

function SourceDetailView({ s, onDeleted }: { s: Source; onDeleted: () => void }) {
  const tr = useTr();
  const lang = useUi((x) => x.lang);
  const { data, error, isLoading, dataUpdatedAt } = useQuery({ queryKey: ["source", s.id], queryFn: () => api.sourceDetail(s.id), refetchInterval: 5000, retry: 1 });
  const [del, setDel] = useState(false);
  const delMut = useAction(api.deleteSource, { ok: tr("已删除", "Deleted"), invalidate: [["sources"]] });
  const paper = s.platform === "paper" && !!s.connection_id;
  const lead = s.kind === "lead_trader";
  const equityHidden = lead && s.platform === "okx";
  const fillsMode = s.lead_mode === "fills";
  const trade = useAction(api.paperTrade, { ok: tr("已提交", "Submitted"), invalidate: [["source", s.id], ["connections"]] });
  const [rebuild, setRebuild] = useState(false);
  const backfillMut = useAction(api.backfillSource, { ok: tr("开始重建", "Rebuild started"), invalidate: [["source", s.id]] });
  const bf = data?.fills?.backfill ?? null;
  return (
    <div className="anim-fade px-4 py-4 md:px-8 md:py-6 [&_table]:min-w-[560px]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-semibold tracking-[-1px]">{s.name}</h2>
            <button title={tr("删除信号源", "Delete source")} onClick={() => setDel(true)} className="text-muted-fg hover:text-danger">
              <Trash2 size={14} />
            </button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-fg">
            {lead ? <span>{leadVenue(s.platform)} {tr("带单员", "lead trader")}</span> : null}
            <span className="num selectable break-all">{s.address ?? s.connection_alias}</span>
            <span className="flex items-center gap-1.5">
              <Dot color={error ? "danger" : "success"} />
              {error ? tr("读取失败", "Unreachable") : tr(`已连接，快照 ${ago(dataUpdatedAt, lang === "en")}`, `Connected, snapshot ${ago(dataUpdatedAt, true)}`)}
            </span>
          </div>
        </div>
        <div className="flex gap-8 text-right max-md:text-left">
          <div>
            <div className="text-xs text-muted-fg">{tr("权益", "Equity")} {s.platform === "hyperliquid" ? "USDC" : "USDT"}</div>
            <div className="num mt-1 text-xl" title={equityHidden ? tr("OKX 不公开带单员权益", "OKX does not publish lead trader equity") : undefined}>
              {equityHidden ? tr("未公开", "Hidden") : num(data?.equity, 0)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-fg">{tr("名义仓位", "Notional")}</div>
            <div className="num mt-1 text-xl">{num(data?.notional, 0)}</div>
          </div>
        </div>
      </div>
      {error ? <div className="mt-6 text-sm text-danger">{errMsg(error)}</div> : null}
      {isLoading ? <Loading /> : null}
      {data ? (
        <>
          {paper ? <PaperTradePanel connectionId={s.connection_id!} /> : null}
          {fillsMode ? (
            <div className="mt-6 rounded-md bg-primary-soft px-4 py-3 text-xs text-fg">
              <div className="font-semibold">{tr("该带单员未公开持仓，以下仓位由公开成交记录推算", "Positions are hidden; the positions below are reconstructed from public fills")}</div>
              <div className="mt-1">
                {tr(
                  `只计入 ${new Date(data.fills?.anchor ?? s.created_at).toLocaleString()} 之后的成交，之前已有的仓位看不到；比带单员实际成交晚约 2 分钟；杠杆未知，「跟随信号源杠杆」会改用任务里的固定值。`,
                  `Only fills after ${new Date(data.fills?.anchor ?? s.created_at).toLocaleString()} count; earlier positions are invisible. About 2 minutes behind the trader. Leverage is unknown, so "follow source leverage" falls back to the task's fixed value.`,
                )}
              </div>
              <div className="mt-1">
                {tr("已计入成交", "Fills applied")} {data.fills?.applied ?? 0} · {tr("最近一笔", "latest")} {data.fills?.last_fill_at ? ago(data.fills.last_fill_at, lang === "en") : tr("暂无", "none yet")}
                {data.fills?.last_trade_at ? ` · ${tr("带单员最近交易", "trader's last trade")} ${ago(data.fills.last_trade_at, lang === "en")}` : ""}
              </div>
              <div className="mt-3">
                <LeadPollSwitch source={s} />
              </div>
              <div className="mt-2 flex items-center gap-3">
                {bf?.running ? (
                  <span className="text-warning">
                    {tr("正在从历史成交重建", "Rebuilding from history")} {bf.fetched}/{bf.total || "?"}
                    {tr("（每 3 秒一页，期间不能启动任务）", " (one page per 3 s; tasks cannot start meanwhile)")}
                  </span>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setRebuild(true)}>
                    {tr("从历史成交重建", "Rebuild from history")}
                  </Button>
                )}
                {!bf?.running && bf?.error ? <span className="text-danger">{tr("重建失败：", "Rebuild failed: ")}{bf.error}</span> : null}
              </div>
            </div>
          ) : null}
          {lead ? (
            <div className="mt-6 rounded-md bg-muted px-4 py-3 text-xs text-muted-fg">
              {tr("交易所带单员只能读到公开持仓：按仓位跟随，不镜像挂单。", "Only public positions are visible: position-follow, no order mirroring.")}
              {s.platform === "binance"
                ? tr("币安公开持仓本身有延迟，实测比带单员实际成交晚约 15 秒到 2.5 分钟，频繁进出的带单员不适合跟。数据来自网页接口，带单员隐藏持仓后任务会按「信号源断线」处理。", " Binance publishes positions with a delay (measured 15 s to 2.5 min after the trader's fill), so fast in-and-out traders are a poor fit. Data comes from the website API; if the trader hides positions, tasks treat it as a lost source.")
                : tr("每 2 秒读取一次。", " Polled every 2 s.")}
              {s.url ? <div className="num selectable mt-1">{s.url}</div> : null}
            </div>
          ) : null}
          <h3 className="mt-8 mb-2 text-md font-semibold">{fillsMode ? tr("推算持仓", "Reconstructed positions") : tr("当前持仓", "Positions")}</h3>
          {data.positions.length === 0 ? (
            <div className="py-6 text-sm text-muted-fg">{tr("无持仓", "No positions")}</div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-fg">
                  <th className="py-2 text-left font-normal">{tr("品种", "Coin")}</th>
                  <th className="text-right font-normal">{tr("数量", "Size")}</th>
                  <th className="text-right font-normal">{tr("开仓均价", "Entry")}</th>
                  <th className="text-right font-normal">{tr("标记价", "Mark")}</th>
                  <th className="text-right font-normal">{tr("杠杆", "Lev")}</th>
                  <th className="text-right font-normal">{tr("未实现盈亏", "uPnL")}</th>
                  {paper ? <th className="w-16 font-normal" /> : null}
                </tr>
              </thead>
              <tbody>
                {data.positions.map((p) => (
                  <tr key={p.symbol} className="border-b border-border">
                    <td className="py-2.5">
                      <span className="mr-2">{p.base}</span>
                      <SideTag size={p.size} />
                    </td>
                    <td className="num text-right">{qty(p.size)}</td>
                    <td className="num text-right">{price(p.entry_px)}</td>
                    <td className="num text-right">{price(p.mark_px)}</td>
                    <td className="num text-right">{p.leverage ? `${Number(p.leverage)}×` : "—"}</td>
                    <td className={clsx("num text-right", pnlClass(p.upnl))}>{signed(p.upnl)}</td>
                    {paper ? (
                      <td className="text-right">
                        <Button variant="ghost" size="sm" loading={trade.isPending && trade.variables?.base === p.base && trade.variables.action === "close"} onClick={() => trade.mutate({ connection_id: s.connection_id!, base: p.base, action: "close" })}>
                          {tr("平仓", "Close")}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          {data.lead_orders || data.lead_orders_error ? <LeadOrders orders={data.lead_orders} error={data.lead_orders_error} /> : null}
          {lead ? null : <h3 className="mt-8 mb-2 text-md font-semibold">{tr("未成交挂单", "Open orders")}</h3>}
          {lead ? null : data.orders.length === 0 ? (
            <div className="py-6 text-sm text-muted-fg">{tr("无挂单", "No open orders")}</div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} className="border-b border-border">
                    <td className="py-2.5">
                      {o.base} {o.kind === "limit" ? tr(`限价${o.buy ? "买" : "卖"}`, `limit ${o.buy ? "buy" : "sell"}`) : o.kind === "stop_market" ? tr(`止损（${o.buy ? "平空" : "平多"}）`, `stop (${o.buy ? "cover" : "sell"})`) : o.kind === "take_profit_market" ? tr("止盈", "take profit") : tr("其他", "other")}
                    </td>
                    <td className="num text-right">{price(o.trigger_px ?? o.price)}</td>
                    <td className="num text-right">{qty(o.qty)}</td>
                    <td className="text-right text-xs text-muted-fg">{o.mirrored_to ? tr(`已镜像到 ${o.mirrored_to} 个账户`, `Mirrored to ${o.mirrored_to}`) : tr("未镜像", "Not mirrored")}</td>
                    {paper ? (
                      <td className="w-16 text-right">
                        <Button variant="ghost" size="sm" loading={trade.isPending && trade.variables?.order_id === o.id} onClick={() => trade.mutate({ connection_id: s.connection_id!, base: o.base, action: "cancel", order_id: o.id })}>
                          {tr("撤单", "Cancel")}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </>
      ) : null}
      <Confirm
        open={rebuild}
        onClose={() => setRebuild(false)}
        title={tr("从历史成交重建推算持仓？", "Rebuild positions from history?")}
        confirmLabel={tr("重建", "Rebuild")}
        busy={backfillMut.isPending}
        onConfirm={() => backfillMut.mutate(s.id, { onSuccess: () => setRebuild(false) })}
        body={
          <div className="flex flex-col gap-2 text-sm">
            <p>{tr("清空当前推算结果，改用币安公开的全部成交记录（约最近 2 个月；成交多的带单员只有最近约 6000 笔）重新推算。", "Discards the current reconstruction and replays every fill Binance still lists (about the last 2 months; only the latest ~6000 for very active traders).")}</p>
            <ul className="list-disc pl-5 text-muted-fg">
              <li>{tr("比这更早开的仓位依然看不到；在那之前开、之后加仓的仓位只会算到加仓部分。", "Positions opened before that stay invisible; ones opened earlier and added to later only count the added part.")}</li>
              <li>{tr("使用该信号源的任务需先停止。重建后再启动，任务会按启动策略处理这些仓位。", "Tasks using this source must be stopped first. When started again, they treat these positions per their start policy.")}</li>
            </ul>
          </div>
        }
      />
      <Confirm
        open={del}
        onClose={() => setDel(false)}
        danger
        title={tr("删除信号源", "Delete source")}
        body={tr(`删除「${s.name}」？被任务使用时无法删除。`, `Delete "${s.name}"? Sources used by tasks cannot be deleted.`)}
        confirmLabel={tr("删除", "Delete")}
        onConfirm={async () => {
          await delMut.mutateAsync(s.id);
          setDel(false);
          onDeleted();
        }}
      />
    </div>
  );
}

/** What an order did to the trader's position. */
function orderAction(o: LeadOrder, tr: (zh: string, en: string) => string) {
  const pnl = Number(o.pnl);
  if (o.pos_side === "LONG") return o.buy ? { text: tr("开多", "Open long"), open: true, long: true } : { text: tr("平多", "Close long"), open: false, long: true };
  if (o.pos_side === "SHORT") return o.buy ? { text: tr("平空", "Close short"), open: false, long: false } : { text: tr("开空", "Open short"), open: true, long: false };
  // One-way: an order that realised PnL closed something.
  if (pnl !== 0) return { text: o.buy ? tr("平空", "Close short") : tr("平多", "Close long"), open: false, long: !o.buy };
  return { text: o.buy ? tr("买入", "Buy") : tr("卖出", "Sell"), open: true, long: o.buy };
}

function LeadOrders({ orders, error }: { orders: LeadOrder[] | null; error: string | null }) {
  const tr = useTr();
  const lang = useUi((x) => x.lang);
  return (
    <>
      <h3 className="mt-8 mb-1 text-md font-semibold">{tr("带单员最近订单", "Trader's recent orders")}</h3>
      <p className="mb-2 text-xs text-muted-fg">{tr("来自币安公开的订单记录，含开仓和平仓，最新在上。仅供查看，任务仍按推算持仓跟单。", "From Binance's public order history, opens and closes, newest first. For reference; tasks still follow the reconstructed positions.")}</p>
      {error ? <div className="py-2 text-xs text-danger">{error}</div> : null}
      {orders && orders.length === 0 ? <div className="py-6 text-sm text-muted-fg">{tr("暂无订单", "No orders")}</div> : null}
      {orders && orders.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-fg">
                <th className="py-2 text-left font-normal">{tr("时间", "Time")}</th>
                <th className="text-left font-normal">{tr("品种", "Symbol")}</th>
                <th className="text-left font-normal">{tr("动作", "Action")}</th>
                <th className="text-right font-normal">{tr("数量", "Qty")}</th>
                <th className="text-right font-normal">{tr("成交均价", "Avg price")}</th>
                <th className="text-right font-normal">{tr("已实现盈亏", "Realised PnL")}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o, i) => {
                const a = orderAction(o, tr);
                return (
                  <tr key={`${o.time}-${o.symbol}-${i}`} className="border-b border-border">
                    <td className="num py-2.5 text-xs text-muted-fg" title={new Date(o.time).toLocaleString()}>
                      {ago(o.time, lang === "en")}
                    </td>
                    <td>{o.symbol}</td>
                    <td className={clsx(a.open ? "font-semibold" : "", a.long ? "text-success" : "text-danger")}>
                      {a.text}
                      <span className="ml-1.5 text-xs font-normal text-muted-fg">{o.type === "MARKET" ? tr("市价", "market") : o.type === "LIMIT" ? tr("限价", "limit") : o.type.toLowerCase()}</span>
                    </td>
                    <td className="num text-right">{qty(o.qty)}</td>
                    <td className="num text-right">{price(o.avg_px)}</td>
                    <td className={clsx("num text-right", Number(o.pnl) === 0 ? "text-muted-fg" : pnlClass(o.pnl))}>{Number(o.pnl) === 0 ? "—" : signed(o.pnl)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function PaperTradePanel({ connectionId }: { connectionId: string }) {
  const tr = useTr();
  const [base, setBase] = useState("BTC");
  const [notional, setNotional] = useState("1000");
  const [price, setPrice] = useState("");
  const [lev, setLev] = useState("10");
  const trade = useAction(api.paperTrade, { ok: tr("已提交", "Submitted"), invalidate: [["source"], ["connections"]] });
  const valid = !!base.trim() && Number(notional) > 0;
  const submit = (buy: boolean) =>
    trade.mutate({ connection_id: connectionId, base: base.trim().toUpperCase(), action: "open", buy, notional, price: price.trim() || null, leverage: Number(lev) || null });
  return (
    <div className="mt-8 rounded-lg border border-border p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-md font-semibold">{tr("模拟下单", "Paper order")}</h3>
        <span className="text-xs text-muted-fg">{tr("按 Hyperliquid 实时价格虚拟成交，跟随该信号源的任务会照常跟单。", "Virtual fills at live Hyperliquid prices; tasks following this source copy them as usual.")}</span>
      </div>
      <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
        <Field label={tr("品种", "Coin")}>
          <Input value={base} onChange={(e) => setBase(e.target.value.toUpperCase())} className="num" placeholder="BTC" />
        </Field>
        <Field label={tr("金额", "Notional")}>
          <Input value={notional} onChange={(e) => setNotional(e.target.value.replace(/[^0-9.]/g, ""))} suffix="USDT" className="num" />
        </Field>
        <Field label={tr("限价（留空为市价）", "Limit (blank = market)")}>
          <Input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} className="num" placeholder={tr("市价", "Market")} />
        </Field>
        <Field label={tr("杠杆", "Leverage")}>
          <Input value={lev} onChange={(e) => setLev(e.target.value.replace(/[^0-9]/g, ""))} suffix="×" className="num" />
        </Field>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={!valid} loading={trade.isPending && trade.variables?.buy === true} onClick={() => submit(true)}>
          {tr("买入 / 做多", "Buy / Long")}
        </Button>
        <Button disabled={!valid} loading={trade.isPending && trade.variables?.buy === false} onClick={() => submit(false)}>
          {tr("卖出 / 做空", "Sell / Short")}
        </Button>
      </div>
    </div>
  );
}

const leadVenue = (p: Platform) => ({ okx: "OKX", binance: "币安" } as Record<string, string>)[p] ?? p;

function AddLeadModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (id: string) => void }) {
  const tr = useTr();
  const [platform, setPlatform] = useState<Platform>("okx");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<{ platform: Platform; query: string } | null>(null);
  const [picked, setPicked] = useState<LeadSummary | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) {
      setQuery("");
      setPicked(null);
      setName("");
      setSubmitted({ platform, query: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const list = useQuery({
    queryKey: ["lead-search", submitted?.platform, submitted?.query],
    queryFn: () => api.searchLeadTraders(submitted!.platform, submitted!.query),
    enabled: open && !!submitted,
    retry: 0,
    staleTime: 60_000,
  });
  const [poll, setPoll] = useState<LeadPoll>("trigger");
  const pollText = useLeadPollText();
  const add = useAction((mode: "fills" | null) => api.addSource({ kind: "lead_trader", name: name.trim(), platform: picked!.platform, address: picked!.id, lead_mode: mode, lead_poll: mode === "fills" ? poll : null }), { ok: tr("已添加", "Added"), invalidate: [["sources"]] });
  const [probing, setProbing] = useState(false);
  const [hidden, setHidden] = useState<LeadProbe | null>(null);
  const toast = useUi((x) => x.toast);
  const lang = useUi((x) => x.lang);
  const finish = async (mode: "fills" | null) => {
    const id = await add.mutateAsync(mode);
    setHidden(null);
    onAdded(id);
    onClose();
  };
  const tryAdd = async () => {
    if (picked!.platform !== "binance") return finish(null);
    setProbing(true);
    try {
      const p = await api.probeLeadTrader(picked!.platform, picked!.id);
      if (p.positions_public) return await finish(null);
      if (!p.fills_public) {
        toast(tr("该带单员未公开持仓，成交记录也不可见，无法跟随", "Positions are hidden and fills are not visible either; cannot follow"), "error");
        return;
      }
      setHidden(p);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setProbing(false);
    }
  };
  const search = (p = platform) => {
    setPicked(null);
    setSubmitted({ platform: p, query: query.trim() });
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      title={tr("添加交易所带单员", "Add exchange lead trader")}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button
            variant="primary"
            disabled={!picked || !name.trim()}
            loading={add.isPending || probing}
            onClick={tryAdd}
          >
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <Confirm
        open={!!hidden}
        onClose={() => setHidden(null)}
        title={tr("该带单员未公开持仓，确认跟单？", "Positions hidden. Follow anyway?")}
        confirmLabel={tr("确认，按成交记录跟单", "Yes, follow from fills")}
        busy={add.isPending}
        onConfirm={() => finish("fills")}
        body={
          <div className="flex flex-col gap-2 text-sm">
            <p>{tr(`「${hidden?.nickname ?? ""}」没有公开持仓，只能用他公开的成交记录推算仓位：`, `"${hidden?.nickname ?? ""}" hides positions; they can only be reconstructed from public fills:`)}</p>
            <ul className="list-disc pl-5 text-muted-fg">
              <li>{tr("比带单员实际成交晚约 2 分钟（实测 122–135 秒），进出频繁的带单员不适合跟。", "About 2 minutes behind the trader (measured 122–135 s); a poor fit for fast in-and-out traders.")}</li>
              <li>{tr("添加后会用公开的历史成交（约最近 2 个月，成交多的只有最近约 6000 笔）推算当前仓位；更早开的仓位看不到。", "After adding, current positions are rebuilt from the public history (about the last 2 months, or the latest ~6000 fills for very active traders); older positions are invisible.")}</li>
              <li>{tr("推算可能与真实持仓不同（例如他平掉历史之前开的仓位时）；杠杆未知。", "The reconstruction can differ from the real positions (e.g. when closing positions older than the history); leverage is unknown.")}</li>
              <li>{tr("数据来自币安网页接口，可能随时失效。", "Data comes from Binance's website API and may stop working.")}</li>
            </ul>
            <div className="mt-1 flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-fg">{tr("成交读取", "Fills polling")}</span>
                <Seg
                  size="sm"
                  value={poll}
                  onChange={setPoll}
                  options={[
                    { value: "trigger", label: pollText.trigger.label },
                    { value: "interval", label: pollText.interval.label },
                  ]}
                />
              </div>
              <div className="text-xs text-muted-fg">{pollText[poll].hint}{tr("添加后也可以随时切换。", " You can switch any time later.")}</div>
            </div>
            <p className="text-xs text-muted-fg">
              {tr("最近一笔成交", "Latest fill")} {hidden?.last_fill_ms ? ago(hidden.last_fill_ms, lang === "en") : "—"}
              {hidden?.equity ? ` · ${tr("权益", "equity")} ${num(hidden.equity, 0)} USDT` : ""}
            </p>
          </div>
        }
      />
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Seg
            value={platform}
            onChange={(v) => {
              setPlatform(v as Platform);
              search(v as Platform);
            }}
            options={[
              { value: "okx", label: "OKX" },
              { value: "binance", label: tr("币安", "Binance") },
            ]}
          />
          <form
            className="flex flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr("昵称、ID 或主页链接", "Nickname, ID or profile link")} autoFocus />
            <Button type="submit" loading={list.isFetching}>
              <Search size={14} />
            </Button>
          </form>
        </div>
        <p className="text-xs text-muted-fg">
          {platform === "okx"
            ? tr("OKX 不支持按昵称搜索，这里只在规模排名前 5 页里筛选；找不到时请粘贴带单员主页链接。OKX 不公开带单员权益，只能用固定倍数或固定名义金额跟单。", "OKX has no nickname search; we filter the top 5 pages by AUM. Paste the profile link otherwise. OKX does not publish equity, so only fixed multiple or fixed notional sizing works.")
            : tr("添加时会检查是否公开持仓；未公开的会请你确认改用成交记录推算（晚约 2 分钟）。", "Checked on add: if positions are hidden you'll be asked to confirm following reconstructed positions (about 2 minutes behind).")}
        </p>
        <div className="max-h-[320px] overflow-y-auto rounded-md border border-border">
          {list.error ? <div className="p-4 text-sm text-danger">{errMsg(list.error)}</div> : null}
          {list.isLoading ? <Loading /> : null}
          {list.data && list.data.length === 0 ? <div className="p-4 text-sm text-muted-fg">{tr("没有找到", "No matches")}</div> : null}
          {list.data?.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setPicked(t);
                setName(t.nickname || t.id);
              }}
              className={clsx("flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-0", picked?.id === t.id ? "bg-muted" : "hover:bg-muted/50")}
            >
              <PlatformTag platform={t.platform} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{t.nickname || t.id}</div>
                <div className="num truncate text-xs text-muted-fg">{t.id}</div>
              </div>
              <div className="shrink-0 text-right text-xs text-muted-fg">
                {t.roi_pct != null ? <div className={clsx("num", pnlClass(t.roi_pct))}>{signed(t.roi_pct)}%</div> : null}
                <div>
                  {t.aum != null ? `AUM ${num(t.aum, 0)}` : ""}
                  {t.copiers != null ? ` · ${t.copiers}${t.max_copiers ? `/${t.max_copiers}` : ""} ${tr("人跟", "copiers")}` : ""}
                </div>
                {t.positions_public === false ? <div className="text-warning">{tr("未公开持仓，可按成交推算", "Positions hidden; can follow fills")}</div> : null}
              </div>
            </button>
          ))}
        </div>
        {picked ? (
          <Field label={tr("名称", "Name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

function AddHlModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (id: string) => void }) {
  const tr = useTr();
  const [name, setName] = useState("");
  const [addr, setAddr] = useState("");
  const [testnet, setTestnet] = useState(false);
  const [touched, setTouched] = useState(false);
  const add = useAction(() => api.addSource({ kind: "hl_address", name, address: addr.trim(), testnet }), { ok: tr("已添加", "Added"), invalidate: [["sources"]] });
  useEffect(() => {
    if (open) {
      setName("");
      setAddr("");
      setTouched(false);
    }
  }, [open]);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
  const err = touched && !valid ? (addr.trim().length !== 42 ? tr(`地址应为 42 位，当前 ${addr.trim().length} 位`, `Address must be 42 characters (now ${addr.trim().length})`) : tr("地址格式不正确", "Invalid address")) : null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr("添加 Hyperliquid 地址", "Add Hyperliquid address")}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button
            variant="primary"
            disabled={!valid || !name.trim()}
            loading={add.isPending}
            onClick={async () => {
              const id = await add.mutateAsync(undefined);
              onAdded(id);
              onClose();
            }}
          >
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={tr("名称", "Name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("如：聪明钱 A", "e.g. Smart money A")} autoFocus />
        </Field>
        <Field label={tr("地址", "Address")} error={err} hint={tr("任意地址或金库地址，公开数据，无需凭证。", "Any address or vault; public data, no credentials.")}>
          <Input value={addr} onChange={(e) => setAddr(e.target.value)} onBlur={() => setTouched(true)} invalid={!!err} placeholder="0x…" className="num" />
        </Field>
        <Toggle checked={testnet} onChange={setTestnet} label={tr("测试网", "Testnet")} />
      </div>
    </Modal>
  );
}

function AddApiModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (id: string) => void }) {
  const tr = useTr();
  const { go } = useUi();
  const { data: conns } = useConnections();
  const [cid, setCid] = useState("");
  const [name, setName] = useState("");
  const add = useAction(() => api.addSource({ kind: "api", name, connection_id: cid }), { ok: tr("已添加", "Added"), invalidate: [["sources"]] });
  const options = conns ?? [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr("添加 API 信号源", "Add API source")}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button
            variant="primary"
            disabled={!cid || !name.trim()}
            loading={add.isPending}
            onClick={async () => {
              const id = await add.mutateAsync(undefined);
              onAdded(id);
              onClose();
            }}
          >
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-xs text-muted-fg">{tr("信号源只需只读权限。先在「连接」页添加只读 Key；也可选模拟账户，在信号源页手动下单来驱动跟单。", "Sources only need read-only keys. Add the key under Connections first, or pick a paper account and trade it by hand from the Sources page.")}</p>
      {options.length === 0 ? (
        <Button variant="link" onClick={() => go("connections")}>
          {tr("去添加连接", "Add a connection")}
        </Button>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label={tr("连接", "Connection")}>
            <div className="flex flex-col gap-1.5">
              {options.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setCid(c.id);
                    if (!name) setName(c.alias);
                  }}
                  className={clsx("flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm", cid === c.id ? "border-fg bg-muted" : "border-border hover:bg-muted/50")}
                >
                  <span>{c.alias}</span>
                  <span className="text-xs text-muted-fg">
                    {c.platform === "paper" ? tr("模拟", "paper") : `${c.platform} · ${c.perms?.trade ? tr("可交易", "trade") : tr("只读", "read-only")}`}
                  </span>
                </button>
              ))}
            </div>
          </Field>
          <Field label={tr("名称", "Name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
