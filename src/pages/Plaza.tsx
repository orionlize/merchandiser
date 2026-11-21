import clsx from "clsx";
import { ArrowUpDown, Check, Copy, CopyPlus, ExternalLink, Info, Search, Star, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { PnlCurveChart, SimCurveChart } from "../components/Charts";
import { Button, Empty, Loading, NumInput, Seg, Select, Spinner, Tabs } from "../components/ui";
import { api, errMsg, type PlazaFactors, type PlazaWallet, type PlazaWindow, type SimStart } from "../lib/api";
import { ago, num, price, qty, shortAddr, signed } from "../lib/format";
import { useTr } from "../lib/i18n";
import { qc, usePlaza, usePlazaWallet, useSources } from "../lib/queries";
import { useUi } from "../lib/store";

// 跟单员广场: public Hyperliquid wallets ranked by copy-fit score.

type Sort = "score" | "pnl" | "roi";

const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/** $4.82M / $640K / $9.1K */
export function usd(v: number) {
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K` : a.toFixed(0);
  return `${v < 0 ? "−" : ""}$${s}`;
}

export const pct = (v: number | null | undefined, dp = 1) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(dp)}%`);
export const signedPct = (v: number | undefined) => (v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)}%`);

export function holdText(sec: number | null, en: boolean) {
  // Analysed but no fills in the last 7 days.
  if (sec === null) return en ? "idle" : "未交易";
  if (sec < 3600) return en ? `${Math.max(1, Math.round(sec / 60))} min` : `${Math.max(1, Math.round(sec / 60))} 分钟`;
  if (sec < 86400) return en ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 3600)} 小时`;
  return en ? `${(sec / 86400).toFixed(1)} d` : `${(sec / 86400).toFixed(1)} 天`;
}

const scoreTone = (s: number) => (s >= 75 ? "success" : s >= 50 ? "primary" : "danger");
const toneText = { success: "text-success", primary: "text-primary", danger: "text-danger" } as const;
const toneBg = { success: "bg-success-soft text-success", primary: "bg-primary-soft text-primary", danger: "bg-danger-soft text-danger" } as const;

export const label = (w: PlazaWallet) => w.name ?? shortAddr(w.address);

/** Cumulative PnL sparkline. */
function Curve({ points, width = 96, height = 28 }: { points?: [number, number][]; width?: number; height?: number }) {
  if (!points || points.length < 2) return <svg width={width} height={height} aria-hidden />;
  const vs = points.map((p) => p[1]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const span = hi - lo || 1;
  const pts = vs.map((v, i) => `${((i / (vs.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`);
  const last = vs[vs.length - 1] - vs[0];
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke={last >= 0 ? "var(--success)" : "var(--danger)"} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

function ScoreBadge({ w, win }: { w: PlazaWallet; win: PlazaWindow }) {
  const tr = useTr();
  if (!w.analyzed) return <span className="text-xs whitespace-nowrap text-muted-fg">{w.error ? tr("失败", "failed") : tr("计算中", "scoring")}</span>;
  const s = w.scores[win]?.score ?? 0;
  return <span className={clsx("num inline-flex h-5 min-w-8 items-center justify-center px-1.5 text-xs font-semibold", toneBg[scoreTone(s)])}>{s}</span>;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={clsx("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs transition-colors duration-150", on ? "bg-primary-soft text-primary" : "bg-muted text-muted-fg hover:text-fg")}>
      {on ? <Check size={12} /> : null}
      {children}
    </button>
  );
}

/** Phone: the plaza and "my sources" share the Sources tab. */
export function SourcesSeg({ active }: { active: "plaza" | "mine" }) {
  const tr = useTr();
  const go = useUi((s) => s.go);
  const { data: sources } = useSources();
  const opts = [
    { v: "plaza" as const, l: tr("跟单员广场", "Trader plaza"), to: "plaza" as const },
    { v: "mine" as const, l: `${tr("我的信号源", "My sources")} ${sources?.length ?? ""}`, to: "sources" as const },
  ];
  return (
    <div className="px-4 pt-3 pb-1 md:hidden">
      <div className="flex rounded-md bg-muted p-0.5">
        {opts.map((o) => (
          <button key={o.v} onClick={() => o.v !== active && go(o.to)} className={clsx("h-8 flex-1 rounded-[3px] text-sm transition-colors duration-150", o.v === active ? "bg-card text-fg" : "text-muted-fg")}>
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Plaza() {
  const tr = useTr();
  const en = useUi((s) => s.lang) === "en";
  const { data, isLoading, error } = usePlaza();
  const [win, setWin] = useState<PlazaWindow>("30d");
  const [sort, setSort] = useState<Sort>("score");
  const [q, setQ] = useState("");
  const [fDD, setFDD] = useState(false);
  const [fNoHft, setFNoHft] = useState(false);
  const [fBig, setFBig] = useState(false);
  const [fFav, setFFav] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  // Phones show details in a bottom sheet.
  const [sheet, setSheet] = useState(false);
  // Wallets ticked for 交易员对比 (at most four).
  const [cmp, setCmp] = useState<string[]>(() => useUi.getState().route.addrs ?? []);
  const toggleCmp = (a: string) => setCmp((c) => (c.includes(a) ? c.filter((x) => x !== a) : c.length >= MAX_COMPARE ? c : [...c, a]));

  const wallets = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (data?.wallets ?? []).filter((w) => {
      if (needle && !w.address.includes(needle) && !(w.name ?? "").toLowerCase().includes(needle)) return false;
      if (fDD && !(w.analyzed && (w.max_dd[win] ?? 1) <= 0.2)) return false;
      if (fNoHft && w.hft) return false;
      if (fBig && w.equity < 1e6) return false;
      if (fFav && !w.favorite) return false;
      return true;
    });
    const key = (w: PlazaWallet) => (sort === "score" ? (w.analyzed ? (w.scores[win]?.score ?? 0) : -1) : sort === "pnl" ? (w.perf[win]?.pnl ?? -Infinity) : (w.perf[win]?.roi ?? -Infinity));
    return list.sort((a, b) => key(b) - key(a) || (b.perf[win]?.pnl ?? 0) - (a.perf[win]?.pnl ?? 0));
  }, [data, q, fDD, fNoHft, fBig, fFav, win, sort]);

  // Desktop keeps a wallet selected.
  useEffect(() => {
    if (!sel && wallets.length) setSel(wallets[0].address);
  }, [wallets, sel]);

  const pasted = q.trim().toLowerCase();
  const lookup = isAddr(pasted) && !wallets.some((w) => w.address === pasted) ? pasted : null;
  const pick = (a: string) => {
    setSel(a);
    setSheet(true);
  };

  if (isLoading) return <Loading />;
  const st = data?.status;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <SourcesSeg active="plaza" />
        <div className="flex flex-col gap-3 px-6 pt-5 pb-3 max-md:px-4 max-md:pt-2">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-[360px] items-center max-md:w-full gap-2 rounded-md border border-input bg-bg px-3 focus-within:border-ring">
              <Search size={14} className="shrink-0 text-muted-fg" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("搜索名称，或粘贴任意 0x 地址", "Search, or paste any 0x address")} className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-fg" />
              {q ? (
                <button onClick={() => setQ("")} className="text-muted-fg hover:text-fg" aria-label={tr("清除", "Clear")}>
                  <X size={14} />
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-fg max-md:hidden">
            <Info size={14} className="mt-px shrink-0" />
            <span>
              {tr(
                "「跟单适配度」综合回撤控制、持仓时长、收益稳定与资金规模（各 25 分）。持仓几分钟的高频钱包会被重罚——跟单延迟会吃掉它们的利润。数据来自 Hyperliquid 公开排行榜与链上成交。",
                "Copy-fit blends drawdown control, holding time, stability and size (25 pts each). High-frequency wallets are heavily penalised — copy latency eats their edge. Data: Hyperliquid public leaderboard and fills.",
              )}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-1">
              {(["7d", "30d", "all"] as const).map((w) => (
                <button key={w} onClick={() => setWin(w)} className={clsx("relative flex h-9 min-w-11 items-center justify-center px-2 text-sm transition-colors duration-150", win === w ? "text-fg" : "text-muted-fg hover:text-fg")}>
                  {{ "7d": tr("7 天", "7D"), "30d": tr("30 天", "30D"), all: tr("全部", "All") }[w]}
                  {win === w ? <span className="absolute right-2 bottom-0 left-2 h-0.5 bg-primary" /> : null}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <ArrowUpDown size={14} className="text-muted-fg max-md:hidden" />
              <Select<Sort>
                value={sort}
                onChange={setSort}
                options={[
                  { value: "score", label: tr("按适配度", "By copy-fit") },
                  { value: "pnl", label: tr("按收益额", "By PnL") },
                  { value: "roi", label: tr("按收益率", "By ROI") },
                ]}
              />
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto">
            <Chip on={fDD} onClick={() => setFDD(!fDD)}>
              {tr("回撤 ≤ 20%", "DD ≤ 20%")}
            </Chip>
            <Chip on={fNoHft} onClick={() => setFNoHft(!fNoHft)}>
              {tr("排除高频", "No HFT")}
            </Chip>
            <Chip on={fBig} onClick={() => setFBig(!fBig)}>
              {tr("账户 ≥ $1M", "Equity ≥ $1M")}
            </Chip>
            <Chip on={fFav} onClick={() => setFFav(!fFav)}>
              <Star size={12} />
              {tr("只看关注", "Starred")}
            </Chip>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-fg">
            <span>{tr(`${wallets.length} 个钱包`, `${wallets.length} wallets`)}</span>
            {st && st.analyzed < st.total ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner />
                {tr(`正在评分 ${st.analyzed}/${st.total}`, `Scoring ${st.analyzed}/${st.total}`)}
              </span>
            ) : null}
            {st?.updated_at ? <span>{tr(`排行榜更新于 ${ago(st.updated_at)}`, `Leaderboard ${ago(st.updated_at, true)}`)}</span> : null}
          </div>
          {st?.error || error ? <div className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{st?.error || errMsg(error)}</div> : null}
        </div>

        {lookup ? (
          <button onClick={() => pick(lookup)} className="mx-6 mb-3 flex items-center gap-2 rounded-md border border-border px-2 py-2.5 text-left text-sm hover:bg-muted max-md:mx-4">
            <Search size={14} className="text-muted-fg" />
            {tr("查看地址", "Look up")} <span className="num">{shortAddr(lookup)}</span>
          </button>
        ) : null}

        {wallets.length === 0 && !lookup ? (
          <Empty title={(data?.wallets.length ?? 0) === 0 ? tr("正在获取排行榜…", "Fetching leaderboard…") : tr("没有符合筛选的钱包", "No wallets match")} hint={(data?.wallets.length ?? 0) === 0 ? tr("首次打开需要几秒钟", "Takes a few seconds the first time") : undefined} />
        ) : (
          <>
            <WalletTable wallets={wallets} win={win} sel={sel} onPick={pick} en={en} cmp={cmp} onCmp={toggleCmp} />
            <WalletCards wallets={wallets} win={win} onPick={pick} en={en} cmp={cmp} onCmp={toggleCmp} />
          </>
        )}
        {cmp.length ? <CompareTray count={cmp.length} onClear={() => setCmp([])} onGo={() => useUi.getState().goTo({ page: "compare", addrs: cmp })} /> : null}
      </div>
      {sel ? <Detail key={sel} address={sel} win={win} sheet={sheet} onClose={() => setSheet(false)} /> : null}
    </div>
  );
}

function Fav({ w }: { w: PlazaWallet }) {
  const tr = useTr();
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await api.plazaFavorite(w.address, !w.favorite);
        } finally {
          qc.invalidateQueries({ queryKey: ["plaza"] });
          qc.invalidateQueries({ queryKey: ["plaza-wallet", w.address] });
        }
      }}
      className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
      aria-label={w.favorite ? tr("取消关注", "Unstar") : tr("关注", "Star")}
      aria-pressed={w.favorite}
    >
      <Star size={14} className={w.favorite ? "fill-primary text-primary" : "text-muted-fg"} />
    </button>
  );
}

function Tags({ w }: { w: PlazaWallet }) {
  const tr = useTr();
  return (
    <>
      {w.task_id ? <span className="shrink-0 bg-success-soft px-1.5 text-xs whitespace-nowrap text-success">{tr("跟单中", "Copying")}</span> : null}
      {w.hft ? <span className="shrink-0 bg-primary-soft px-1.5 text-xs whitespace-nowrap text-warning">{tr("高频", "HFT")}</span> : null}
    </>
  );
}

export const MAX_COMPARE = 4;

function CompareTray({ count, onClear, onGo }: { count: number; onClear: () => void; onGo: () => void }) {
  const tr = useTr();
  return (
    <div className="sticky bottom-0 z-10 mt-auto flex items-center gap-3 border-t border-border bg-card px-6 py-3 max-md:px-4">
      <span className="flex-1 text-sm">{tr(`已勾选 ${count} 个钱包（最多 ${MAX_COMPARE} 个）`, `${count} selected (up to ${MAX_COMPARE})`)}</span>
      <Button variant="ghost" onClick={onClear}>
        {tr("清空", "Clear")}
      </Button>
      <Button variant="primary" disabled={count < 2} onClick={onGo}>
        {tr("开始对比", "Compare")}
      </Button>
    </div>
  );
}

function CmpBox({ w, cmp, onCmp }: { w: PlazaWallet; cmp: string[]; onCmp: (a: string) => void }) {
  const tr = useTr();
  const on = cmp.includes(w.address);
  const full = !on && cmp.length >= MAX_COMPARE;
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={full}
      onClick={(e) => {
        e.stopPropagation();
        onCmp(w.address);
      }}
      title={full ? tr(`最多对比 ${MAX_COMPARE} 个`, `Up to ${MAX_COMPARE}`) : tr("加入对比", "Add to compare")}
      aria-label={tr("加入对比", "Add to compare")}
      className="-m-2 flex h-8 w-8 shrink-0 items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className={clsx("flex h-4 w-4 items-center justify-center rounded-[3px] border transition-colors duration-150", on ? "border-primary bg-primary text-on-primary" : "border-input")}>{on ? <Check size={11} strokeWidth={3} /> : null}</span>
    </button>
  );
}

function WalletTable({ wallets, win, sel, onPick, en, cmp, onCmp }: { wallets: PlazaWallet[]; win: PlazaWindow; sel: string | null; onPick: (a: string) => void; en: boolean; cmp: string[]; onCmp: (a: string) => void }) {
  const tr = useTr();
  const th = "px-2 py-2 text-left text-xs font-normal text-muted-fg whitespace-nowrap";
  return (
    <div className="overflow-x-auto px-6 pb-6 max-md:hidden">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className={clsx(th, "w-16")}>
              <span title={tr("勾选加入对比", "Tick to compare")}>{tr("对比 #", "Cmp #")}</span>
            </th>
            <th className={th}>{tr("钱包", "Wallet")}</th>
            <th className={clsx(th, "text-right")}>{tr("收益", "PnL")}</th>
            <th className={clsx(th, "text-right")}>{tr("收益率", "ROI")}</th>
            <th className={clsx(th, "text-right")}>{tr("权益", "Equity")}</th>
            <th className={clsx(th, "text-right")}>{tr("最大回撤", "Max DD")}</th>
            <th className={clsx(th, "text-right")}>{tr("平均持仓", "Avg hold")}</th>
            <th className={th}>{tr("曲线", "Curve")}</th>
            <th className={clsx(th, "text-right")}>{tr("适配度", "Fit")}</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {wallets.map((w, i) => {
            const p = w.perf[win];
            const dd = w.max_dd[win];
            return (
              <tr key={w.address} onClick={() => onPick(w.address)} className={clsx("cursor-pointer border-b border-border transition-colors duration-150", sel === w.address ? "bg-card" : "hover:bg-card/60")}>
                <td className="px-2 py-2.5">
                  <span className="flex items-center gap-2.5">
                    <CmpBox w={w} cmp={cmp} onCmp={onCmp} />
                    <span className="num text-xs text-muted-fg">{i + 1}</span>
                  </span>
                </td>
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm">{label(w)}</span>
                    <Tags w={w} />
                  </div>
                  {w.name ? <div className="num text-xs text-muted-fg">{shortAddr(w.address)}</div> : null}
                </td>
                <td className={clsx("num px-2 py-2.5 text-right text-sm", (p?.pnl ?? 0) >= 0 ? "text-success" : "text-danger")}>{p ? signed(p.pnl, 0) : "—"}</td>
                <td className={clsx("num px-2 py-2.5 text-right text-sm", (p?.roi ?? 0) >= 0 ? "text-success" : "text-danger")}>{signedPct(p?.roi)}</td>
                <td className="num px-2 py-2.5 text-right text-sm">{usd(w.equity)}</td>
                <td className={clsx("num px-2 py-2.5 text-right text-sm", (dd ?? 0) > 0.25 && "text-warning")}>{w.analyzed ? pct(dd) : "—"}</td>
                <td className={clsx("px-2 py-2.5 text-right text-sm whitespace-nowrap", w.hft && "text-warning")}>{w.analyzed ? holdText(w.avg_hold_sec, en) : "—"}</td>
                <td className="px-2 py-1">
                  <Curve points={w.curves[win]} width={72} />
                </td>
                <td className="px-2 py-2.5 text-right">
                  <ScoreBadge w={w} win={win} />
                </td>
                <td className="px-1">
                  <Fav w={w} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WalletCards({ wallets, win, onPick, en, cmp, onCmp }: { wallets: PlazaWallet[]; win: PlazaWindow; onPick: (a: string) => void; en: boolean; cmp: string[]; onCmp: (a: string) => void }) {
  const tr = useTr();
  return (
    <div className="md:hidden">
      {wallets.map((w) => {
        const p = w.perf[win];
        return (
          <div key={w.address} role="button" tabIndex={0} onClick={() => onPick(w.address)} onKeyDown={(e) => e.key === "Enter" && onPick(w.address)} className="flex w-full cursor-pointer items-center gap-3 border-b border-border px-4 py-3 text-left">
            <CmpBox w={w} cmp={cmp} onCmp={onCmp} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold">{label(w)}</span>
                <Tags w={w} />
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-fg">
                <ScoreBadge w={w} win={win} />
                {w.analyzed ? (
                  <>
                    <span className={clsx((w.max_dd[win] ?? 0) > 0.25 && "text-warning")}>
                      {tr("回撤", "DD")} {pct(w.max_dd[win])}
                    </span>
                    <span className={clsx(w.hft && "text-warning")}>
                      {tr("持仓", "Hold")} {holdText(w.avg_hold_sec, en)}
                    </span>
                  </>
                ) : null}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end">
              <span className={clsx("num text-md font-semibold", (p?.roi ?? 0) >= 0 ? "text-success" : "text-danger")}>{signedPct(p?.roi)}</span>
              <span className="num text-xs text-muted-fg">{p ? signed(p.pnl, 0) : "—"}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FactorBar({ name, v }: { name: string; v: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-xs text-muted-fg">{name}</span>
      <span className="h-1.5 flex-1 bg-muted">
        <span className="block h-full bg-primary" style={{ width: `${(v / 25) * 100}%` }} />
      </span>
      <span className="num w-10 text-right text-xs">{Math.round(v)}/25</span>
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: ReactNode; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-fg">{k}</span>
      <span className={clsx("num text-sm font-semibold", tone)}>{v}</span>
    </div>
  );
}

function Detail({ address, win, sheet, onClose }: { address: string; win: PlazaWindow; sheet: boolean; onClose: () => void }) {
  const tr = useTr();
  const en = useUi((s) => s.lang) === "en";
  const { go, toast } = useUi();
  const { data: w, isLoading, error } = usePlazaWallet(address);
  const [busy, setBusy] = useState<"follow" | "add" | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"overview" | "positions" | "sim">("overview");
  // The capital of the last simulation run, carried into the wizard.
  const [simCapital, setSimCapital] = useState<number | null>(null);

  const ensureSource = async (d: PlazaWallet) => {
    if (d.source_id) return d.source_id;
    const id = await api.addSource({ kind: "hl_address", name: d.name ?? `HL ${shortAddr(d.address)}`, address: d.address, testnet: false });
    qc.invalidateQueries({ queryKey: ["sources"] });
    qc.invalidateQueries({ queryKey: ["plaza"] });
    qc.invalidateQueries({ queryKey: ["plaza-wallet", d.address] });
    return id;
  };

  const body = (() => {
    if (isLoading)
      return (
        <div className="flex flex-col items-center gap-2 py-16 text-xs text-muted-fg">
          <Spinner />
          {tr("正在分析该地址的曲线与成交…", "Analysing curve and fills…")}
        </div>
      );
    if (error || !w) return <div className="py-10 text-center text-sm text-danger">{errMsg(error)}</div>;
    const sc = w.scores[win];
    const p = w.perf[win];
    const f: PlazaFactors = sc?.factors ?? { dd: 0, hold: 0, stable: 0, size: 0 };
    const odd = w.coins.filter((c) => c.includes(":") || c.startsWith("@"));
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-lg font-semibold">{label(w)}</span>
              <Tags w={w} />
            </div>
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-fg">
              <span className="num">{shortAddr(w.address)}</span>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(w.address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="flex h-6 w-6 items-center justify-center hover:text-fg"
                aria-label={tr("复制地址", "Copy address")}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              <a href={`https://app.hyperliquid.xyz/explorer/address/${w.address}`} target="_blank" rel="noreferrer" className="flex h-6 w-6 items-center justify-center hover:text-fg" aria-label={tr("在 Hyperliquid 查看", "View on Hyperliquid")}>
                <ExternalLink size={12} />
              </a>
              <Fav w={w} />
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end">
            <span className="text-xs text-muted-fg">{tr("跟单适配度", "Copy-fit")}</span>
            <span className={clsx("num text-2xl font-semibold", toneText[scoreTone(sc?.score ?? 0)])}>{sc?.score ?? "—"}</span>
          </div>
        </div>

        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "overview", label: tr("概览", "Overview") },
            { value: "positions", label: tr(`当前持仓 ${w.positions.length}`, `Positions ${w.positions.length}`) },
            {
              value: "sim",
              label: (
                <>
                  {tr("跟单模拟", "Simulate")}
                  <span className="ml-1 rounded-sm bg-primary-soft px-1 text-[11px] font-semibold text-primary">{tr("新", "New")}</span>
                </>
              ),
            },
          ]}
        />
        {tab === "sim" ? <SimPanel address={w.address} hft={w.hft} onRun={setSimCapital} /> : null}
        {tab === "overview" ? (
          <>
            <div className="flex flex-col gap-2">
              <FactorBar name={tr("回撤控制", "Drawdown")} v={f.dd} />
              <FactorBar name={tr("持仓时长", "Holding")} v={f.hold} />
              <FactorBar name={tr("收益稳定", "Stability")} v={f.stable} />
              <FactorBar name={tr("资金规模", "Size")} v={f.size} />
            </div>

            <div className="grid grid-cols-3 gap-x-3 gap-y-4 rounded-md bg-muted p-3">
              <Stat k={tr("收益", "PnL")} v={p ? signed(p.pnl, 0) : "—"} tone={(p?.pnl ?? 0) >= 0 ? "text-success" : "text-danger"} />
              <Stat k={tr("收益率", "ROI")} v={signedPct(p?.roi)} tone={(p?.roi ?? 0) >= 0 ? "text-success" : "text-danger"} />
              <Stat k={tr("账户权益", "Equity")} v={usd(w.equity)} />
              <Stat k={tr("最大回撤", "Max DD")} v={pct(w.max_dd[win])} tone={(w.max_dd[win] ?? 0) > 0.25 ? "text-warning" : undefined} />
              <Stat k={tr("平均持仓", "Avg hold")} v={holdText(w.avg_hold_sec, en)} tone={w.hft ? "text-warning" : undefined} />
              <Stat k={tr("日均成交", "Fills/day")} v={num(w.trades_per_day, w.trades_per_day < 10 ? 1 : 0)} tone={w.hft ? "text-warning" : undefined} />
              <Stat k={tr("胜率 (7天)", "Win rate (7D)")} v={pct(w.win_rate, 0)} />
            </div>

            <div>
              <div className="mb-1 text-xs text-muted-fg">{tr("累计收益", "Cumulative PnL")}</div>
              {(w.curves[win]?.length ?? 0) > 1 ? <PnlCurveChart points={w.curves[win]!} height={160} compact /> : <div className="py-6 text-center text-xs text-muted-fg">—</div>}
            </div>
          </>
        ) : null}

        {tab === "positions" ? (
          <div>
            {w.positions_error ? <div className="text-xs text-danger">{w.positions_error}</div> : null}
            {w.positions.length === 0 && !w.positions_error ? <div className="text-xs text-muted-fg">{tr("暂无持仓", "No positions")}</div> : null}
            {w.positions.slice(0, 8).map((ps) => (
              <div key={ps.coin} className="flex items-center justify-between border-b border-border py-2 text-sm">
                <span className="flex items-center gap-2">
                  <span className={clsx("px-1 text-xs", ps.size > 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>{ps.size > 0 ? tr("多", "L") : tr("空", "S")}</span>
                  {ps.coin}
                  <span className="num text-xs text-muted-fg">{ps.leverage}x</span>
                </span>
                <span className="num text-xs text-muted-fg">
                  {qty(Math.abs(ps.size))} @ {price(ps.entry_px)}
                </span>
                <span className={clsx("num text-xs", ps.upnl >= 0 ? "text-success" : "text-danger")}>{signed(ps.upnl, 0)}</span>
              </div>
            ))}
          </div>
        ) : null}

        {tab !== "sim" ? (
          <div className={clsx("flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs", w.hft ? "text-warning" : "text-muted-fg")}>
            {w.hft ? <TriangleAlert size={14} className="mt-px shrink-0" /> : <Info size={14} className="mt-px shrink-0" />}
            <span>
              {w.hft
                ? tr(`平均持仓仅 ${holdText(w.avg_hold_sec, false)}、日均 ${num(w.trades_per_day, 0)} 笔成交，跟单延迟会吃掉大部分利润，不支持一键跟单。`, "Positions last minutes; copy latency would eat most of the edge, so one-click copy is disabled.")
                : w.task_id
                  ? tr("你已有任务在跟这个地址，再建一个会重复下单。", "A task already follows this address; another would double the orders.")
                  : tr("按仓位镜像该地址的公开持仓，下一步在任务向导里设置资金比例与风控。", "Mirrors this address's public positions; set sizing and risk in the task wizard next.")}
              {odd.length && !w.hft ? tr(` 其中 ${odd.slice(0, 3).join("、")} 等非标准合约不会被跟随。`, ` Non-standard markets (${odd.slice(0, 3).join(", ")}) are not copied.`) : ""}
            </span>
          </div>
        ) : null}
      </div>
    );
  })();
  const simCta = tab === "sim" && simCapital != null;

  const cta = w ? (
    <div className="flex flex-col gap-2">
      {w.task_id ? (
        <Button variant="primary" className="h-11 w-full text-md" onClick={() => go("task", w.task_id!)}>
          {tr("查看跟单任务", "View copy task")}
        </Button>
      ) : (
        <Button
          variant="primary"
          className="h-11 w-full text-md"
          disabled={w.hft}
          loading={busy === "follow"}
          onClick={async () => {
            setBusy("follow");
            try {
              const sid = await ensureSource(w);
              go("wizard", undefined, sid, simCta ? String(simCapital) : undefined);
            } catch (e) {
              toast(errMsg(e), "error");
            } finally {
              setBusy(null);
            }
          }}
        >
          {w.hft ? null : <CopyPlus size={16} />}
          {w.hft ? tr("高频钱包不支持一键跟单", "HFT wallets can't be copied") : simCta ? tr(`用 ${num(simCapital, 0)} USDT 本金跟单`, `Copy with ${num(simCapital, 0)} USDT`) : tr("跟单此钱包", "Copy this wallet")}
        </Button>
      )}
      {!w.task_id ? (
        w.source_id ? (
          <div className="py-1 text-center text-xs text-muted-fg">{tr("已在「我的信号源」中", "Already in My sources")}</div>
        ) : (
          <Button
            variant="ghost"
            className="h-10 w-full text-muted-fg"
            loading={busy === "add"}
            onClick={async () => {
              setBusy("add");
              try {
                await ensureSource(w);
                toast(tr("已添加为信号源", "Added as a source"));
              } catch (e) {
                toast(errMsg(e), "error");
              } finally {
                setBusy(null);
              }
            }}
          >
            {tr("只添加为信号源", "Only add as source")}
          </Button>
        )
      ) : null}
    </div>
  ) : null;

  return (
    <>
      <aside className="flex w-[392px] shrink-0 flex-col border-l border-border bg-card max-md:hidden">
        <div className="flex-1 overflow-y-auto p-5">{body}</div>
        {cta ? <div className="border-t border-border p-4">{cta}</div> : null}
      </aside>
      {sheet ? (
        <div className="anim-fade fixed inset-0 z-50 flex flex-col justify-end bg-black/60 md:hidden" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <div className="flex max-h-[88vh] flex-col rounded-t-xl bg-card">
            <div className="flex justify-center pt-2 pb-1">
              <span className="h-1 w-9 rounded bg-border" />
            </div>
            <div className="flex-1 overflow-y-auto px-4 pt-2 pb-4">{body}</div>
            {cta ? <div className="border-t border-border px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]">{cta}</div> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}


/** 跟单模拟: replays the wallet's public fills as a follower with this capital. */
function SimPanel({ address, hft, onRun }: { address: string; hft: boolean; onRun: (capital: number | null) => void }) {
  const tr = useTr();
  const [capital, setCapital] = useState("1000");
  const [win, setWin] = useState<"7d" | "30d">("30d");
  const [slip, setSlip] = useState("5");
  const [start, setStart] = useState<SimStart>("new_only");
  const [run, setRun] = useState({ capital: 1000, win: "30d" as "7d" | "30d", slip: 5, start: "new_only" as SimStart });
  const invalid = !(Number(capital) >= 10);
  const { data: r, isFetching, error } = useQuery({
    queryKey: ["plaza-sim", address, run.win, run.capital, run.slip, run.start],
    queryFn: () => api.plazaSimulate({ address, window: run.win, capital: run.capital, slipBps: run.slip, start: run.start }),
    staleTime: 5 * 60_000,
    retry: 0,
  });
  useEffect(() => onRun(r ? r.capital : null), [r, onRun]);
  // A capped history covers less than the window: say how much it does cover.
  const days = r?.truncated ? ((r.to - r.from) / 86_400_000).toFixed(1) : run.win === "7d" ? 7 : 30;
  const skipPct = r && r.considered ? (r.skipped / r.considered) * 100 : 0;
  const tone = (v: number) => (v > 0 ? "text-success" : v < 0 ? "text-danger" : undefined);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-fg">{tr("模拟本金", "Capital")}</span>
          <NumInput className="w-32" value={capital} onChange={setCapital} suffix="USDT" invalid={invalid} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-fg">{tr("区间", "Window")}</span>
          <Seg
            value={win}
            onChange={setWin}
            options={[
              { value: "7d", label: tr("7 天", "7d") },
              { value: "30d", label: tr("30 天", "30d") },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-fg">{tr("延迟滑点", "Slippage")}</span>
          <NumInput className="w-24" value={slip} onChange={setSlip} suffix="bps" />
        </div>
        <Button disabled={invalid} loading={isFetching} onClick={() => setRun({ capital: Number(capital), win, slip: Math.min(Number(slip) || 0, 500), start })}>
          {tr("重新模拟", "Run again")}
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center text-xs text-muted-fg">
          {tr("起始持仓", "At the start")}
          <span className="ml-1 rounded-sm bg-primary-soft px-1 text-[11px] font-semibold text-primary">{tr("新", "New")}</span>
        </span>
        <Seg
          value={start}
          onChange={(v) => {
            setStart(v);
            if (!invalid) setRun({ capital: Number(capital), win, slip: Math.min(Number(slip) || 0, 500), start: v });
          }}
          options={[
            { value: "new_only", label: tr("只跟新开仓位", "New positions only") },
            { value: "sync_existing", label: tr("同步已有持仓", "Sync held positions") },
          ]}
        />
        <span className="text-xs text-muted-fg">
          {start === "new_only"
            ? tr("区间开始时已持有的仓位不跟，和新建任务默认行为一致", "Positions held when the window opens are left out, like a new task by default")
            : tr("按区间开始时的持仓和当时价格直接建仓，适合长期持仓的钱包", "Buys into what was held when the window opened, at that price; suits wallets that hold for long")}
        </span>
      </div>
      {error ? <div className="text-xs text-danger">{errMsg(error)}</div> : null}
      {!r && isFetching ? (
        <div className="flex flex-col items-center gap-2 py-10 text-xs text-muted-fg">
          <Spinner />
          {tr("正在回放该钱包的公开成交…", "Replaying the wallet's public fills…")}
          <span>{tr("成交多的钱包首次需要十几秒", "Very active wallets take a few seconds the first time")}</span>
        </div>
      ) : null}
      {r ? (
        <>
          <div className="rounded-md bg-muted p-3">
            <div className="text-xs text-muted-fg">{tr(`近 ${days} 天跟单这个钱包，预计盈亏`, `Copying the last ${days} days would have made`)}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className={clsx("num text-2xl font-semibold", tone(r.pnl))}>{signed(r.pnl, 2)}</span>
              <span className={clsx("num text-sm", tone(r.roi))}>{signedPct(r.roi)}</span>
            </div>
            <div className="mt-1 text-xs text-muted-fg">
              {tr("交易员同期收益率", "Trader over the same window")} <span className={clsx("num", tone(r.trader_roi))}>{signedPct(r.trader_roi)}</span>
              {r.efficiency != null ? tr(`，跟单效率 ${pct(r.efficiency)}`, `, efficiency ${pct(r.efficiency)}`) : ""}
            </div>
          </div>
          <div>
            <div className={clsx("mb-1 flex flex-wrap items-center gap-3 text-xs text-muted-fg", !(r.considered > 0 && r.curve.length > 1) && "hidden")}>
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-4 bg-primary" />
                {tr("模拟跟单（含滑点、手续费、最小下单量）", "Simulated (slippage, fees, minimum size)")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-0 w-4 border-t border-dashed" style={{ borderColor: "var(--chart-avg)" }} />
                {tr("交易员按比例", "Trader, scaled")}
              </span>
            </div>
            {r.considered > 0 && r.curve.length > 1 ? (
              <SimCurveChart curve={r.curve} height={170} />
            ) : (
              <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-fg">
                {r.unsupported.length && !r.ignored.length
                  ? tr(`区间内只交易了 HIP-3 自建市场（${r.unsupported.slice(0, 3).join("、")}），本系统不跟这类市场`, `It only traded builder-deployed (HIP-3) markets (${r.unsupported.slice(0, 3).join(", ")}), which are not copied`)
                  : r.ignored.length
                    ? tr("仓位都是在窗口开始前开的，按「只跟新开仓位」区间内没有可跟的成交", "Every position predates the window, so with new positions only there was nothing to copy")
                    : tr("区间内没有可跟的成交", "Nothing to copy in this window")}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-4 rounded-md bg-muted p-3">
            <Stat k={tr("跟单效率", "Efficiency")} v={r.efficiency != null ? pct(r.efficiency) : "—"} tone={r.efficiency != null && r.efficiency < 0.6 ? "text-warning" : undefined} />
            <Stat k={tr("最大回撤", "Max DD")} v={r.max_dd > 0 ? `−${(r.max_dd * 100).toFixed(1)}%` : "0.0%"} tone={r.max_dd > 0.25 ? "text-warning" : undefined} />
            <Stat k={tr("模拟成交", "Simulated fills")} v={tr(`${r.trades} 笔`, `${r.trades}`)} />
            <Stat k={tr("低于最小下单跳过", "Skipped (too small)")} v={`${r.skipped}（${skipPct.toFixed(0)}%）`} tone={skipPct > 20 ? "text-warning" : undefined} />
            <Stat k={tr("手续费", "Fees")} v={signed(-r.fees, 2)} />
            <Stat k={tr("滑点成本", "Slippage")} v={signed(-r.slip_cost, 2)} />
          </div>
          {r.coins.length ? (
            <div>
              <div className="mb-1 text-xs text-muted-fg">{tr("按币种", "By coin")}</div>
              {r.coins.slice(0, 6).map((c) => (
                <div key={c.coin} className="flex items-center justify-between border-b border-border py-2 text-sm last:border-b-0">
                  <span>{c.coin}</span>
                  <span className="num text-xs text-muted-fg">{tr(`${c.trades} 笔`, `${c.trades} fills`)}</span>
                  <span className={clsx("num w-24 text-right text-xs", tone(c.pnl))}>{signed(c.pnl, 2)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {r.suggest_capital ? (
            <div className="flex items-start gap-2 rounded-md bg-primary-soft px-3 py-2 text-xs">
              <Info size={14} className="mt-px shrink-0 text-primary" />
              <span>{tr(`${skipPct.toFixed(0)}% 的加减仓因低于 10 USDT 最小下单量被跳过。本金提高到 ${num(r.suggest_capital, 0)} USDT 以上，大部分被跳过的加减仓都能跟上。`, `${skipPct.toFixed(0)}% of changes were below the 10 USDT minimum. With ${num(r.suggest_capital, 0)} USDT or more most of them would be copied.`)}</span>
            </div>
          ) : null}
          {r.ignored.length || r.synced?.length || r.unsupported.length || r.truncated || hft ? (
            <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-fg">
              <TriangleAlert size={14} className="mt-px shrink-0" />
              <span>
                {r.ignored.length ? tr(`窗口开始时已持有的 ${r.ignored.slice(0, 4).join("、")} 按「只跟新开仓位」不计入。`, `${r.ignored.slice(0, 4).join(", ")} were already held at the start and are left out (new positions only).`) : ""}
                {r.synced?.length ? tr(`窗口开始时已持有的 ${r.synced.slice(0, 4).join("、")} 按首个成交价建仓计入。`, `${r.synced.slice(0, 4).join(", ")} were held at the start and bought in at the first price seen.`) : ""}
                {r.unsupported.length ? tr(` ${r.unsupported.slice(0, 3).join("、")} 是 HIP-3 自建市场，本系统不跟，未计入。`, ` ${r.unsupported.slice(0, 3).join(", ")} are builder-deployed (HIP-3) markets, which are not copied.`) : ""}
                {r.truncated ? tr(` 成交过多，Hyperliquid 只提供最近 1 万笔，只回放了最近 ${days} 天。`, ` Hyperliquid only serves the latest 10,000 fills, so only the last ${days} days were replayed.`) : ""}
                {hft ? tr(" 高频钱包实际跟单延迟更大，结果偏乐观。", " For HFT wallets real latency is worse; this is optimistic.") : ""}
              </span>
            </div>
          ) : null}
          <p className="text-center text-xs text-muted-fg">{tr("基于该钱包公开成交回放，历史表现不代表未来收益", "Replayed from public fills; past results do not predict future returns")}</p>
        </>
      ) : null}
    </div>
  );
}
