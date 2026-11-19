import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronLeft, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Confirm, Dot, Empty, Field, Input, Loading, Modal, SideTag, Toggle } from "../components/ui";
import { api, errMsg, type Source } from "../lib/api";
import { ago, num, pnlClass, price, qty, shortAddr, signed } from "../lib/format";
import { useTr } from "../lib/i18n";
import { useAction, useConnections, useSources } from "../lib/queries";
import { useUi } from "../lib/store";
import { SourcesSeg } from "./Plaza";

export function Sources() {
  const tr = useTr();
  const { data: sources, isLoading } = useSources();
  const [sel, setSel] = useState<string | null>(null);
  const [addHl, setAddHl] = useState(false);
  const [addApi, setAddApi] = useState(false);
  // Phones show the list or one source, not both.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!sel && sources?.length) setSel(sources[0].id);
  }, [sources, sel]);

  if (isLoading) return <Loading />;
  const groups: [string, Source[]][] = [
    [tr("Hyperliquid 地址", "Hyperliquid addresses"), (sources ?? []).filter((s) => s.kind === "hl_address" && !legacy(s))],
    [tr("只读 API 账户", "Read-only API accounts"), (sources ?? []).filter((s) => s.kind === "api" && s.platform === "hyperliquid")],
    [tr("模拟账户", "Paper accounts"), (sources ?? []).filter((s) => s.kind === "api" && s.platform === "paper")],
    // Left over from removed venues / lead traders: listed only so they can be deleted.
    [tr("已不支持（请删除）", "No longer supported (delete)"), (sources ?? []).filter(legacy)],
  ];
  const current = sources?.find((s) => s.id === sel);

  return (
    <div className="flex h-full min-h-0">
      <div className={clsx("flex w-[340px] shrink-0 flex-col border-r border-border max-md:w-full max-md:border-r-0", open && "max-md:hidden")}>
        <SourcesSeg active="mine" />
        <div className="grid grid-cols-2 gap-2 p-4">
          <Button onClick={() => setAddApi(true)}>
            <Plus size={14} />
            {tr("API 信号源", "API source")}
          </Button>
          <Button onClick={() => setAddHl(true)}>
            <Plus size={14} />
            {tr("HL 地址", "HL address")}
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
                    <div className="num mt-0.5 truncate text-xs text-muted-fg">{s.kind === "hl_address" ? shortAddr(s.address) : legacy(s) ? `${s.platform} · ${s.address ?? s.connection_alias ?? ""}` : `${s.connection_alias ?? ""} · ${s.platform === "paper" ? tr("模拟", "paper") : s.platform}`}</div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-fg">
                    {s.testnet ? <div className="text-primary">{tr("测试网", "Testnet")}</div> : null}
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
        ) : <Empty title={tr("还没有信号源", "No sources yet")} hint={tr("添加任意 Hyperliquid 地址（无需凭证），或用 Hyperliquid API 连接、模拟账户作为信号源。", "Add any Hyperliquid address (no credentials needed), or use a Hyperliquid API connection or a paper account.")} />}
      </div>
      <AddHlModal open={addHl} onClose={() => setAddHl(false)} onAdded={setSel} />
      <AddApiModal open={addApi} onClose={() => setAddApi(false)} onAdded={setSel} />
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
  const trade = useAction(api.paperTrade, { ok: tr("已提交", "Submitted"), invalidate: [["source", s.id], ["connections"]] });
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
            <div className="num mt-1 text-xl">{num(data?.equity, 0)}</div>
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
          <h3 className="mt-8 mb-2 text-md font-semibold">{tr("当前持仓", "Positions")}</h3>
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
          <h3 className="mt-8 mb-2 text-md font-semibold">{tr("未成交挂单", "Open orders")}</h3>
          {data.orders.length === 0 ? (
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
  const options = (conns ?? []).filter((c) => c.platform === "hyperliquid" || c.platform === "paper");
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

const legacy = (s: Source) => (s.kind !== "hl_address" && s.kind !== "api") || (s.platform !== "hyperliquid" && s.platform !== "paper");
