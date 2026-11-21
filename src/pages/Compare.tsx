import { useQueries, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Plus, Star, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { ReturnsChart } from "../components/Charts";
import { Button, Empty, Seg, Spinner } from "../components/ui";
import { api, errMsg, type PlazaWallet, type PlazaWalletDetail, type PlazaWindow, type SimResult } from "../lib/api";
import { num, shortAddr } from "../lib/format";
import { useTr } from "../lib/i18n";
import { qc, usePlaza } from "../lib/queries";
import { useUi } from "../lib/store";
import { holdText, label, MAX_COMPARE, pct, signedPct, usd } from "./Plaza";

// 交易员对比: up to four plaza wallets side by side.

const SIM_CAPITAL = 1000;
const SIM_SLIP = 5;
const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/** The window's PnL curve as a return on the equity it started from. */
function returns(w: PlazaWallet, win: PlazaWindow): [number, number][] {
  const pts = w.curves[win];
  if (!pts || pts.length < 2) return [];
  const p = w.perf[win];
  const gain = pts[pts.length - 1][1] - pts[0][1];
  // The leaderboard's ROI is PnL over the starting capital; recover that base.
  let base = p && Math.abs(p.roi) > 1e-6 ? p.pnl / p.roi : w.equity - gain;
  if (!(base > 0)) base = w.equity;
  if (!(base > 0)) return [];
  return pts.map(([t, v]) => [t, (v - pts[0][1]) / base]);
}

type Better = "high" | "low" | null;
interface Row {
  key: string;
  label: string;
  better: Better;
  value: (w: PlazaWalletDetail) => number | null;
  show: (w: PlazaWalletDetail) => ReactNode;
}

export function Compare() {
  const tr = useTr();
  const en = useUi((s) => s.lang) === "en";
  const { route, goTo } = useUi();
  const addrs = route.addrs ?? [];
  const [win, setWin] = useState<PlazaWindow>("30d");
  const [pick, setPick] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sims, setSims] = useState<Set<string>>(new Set());
  const { data: plaza } = usePlaza();
  const setAddrs = (a: string[]) => goTo({ page: "compare", addrs: a });

  const qs = useQueries({ queries: addrs.map((a) => ({ queryKey: ["plaza-wallet", a], queryFn: () => api.plazaWallet(a), staleTime: 30_000 })) });
  const simWin = win === "7d" ? "7d" : "30d";
  const simQs = useQueries({
    queries: addrs.map((a) => ({
      queryKey: ["plaza-sim", a, simWin, SIM_CAPITAL, SIM_SLIP, "new_only"],
      queryFn: () => api.plazaSimulate({ address: a, window: simWin, capital: SIM_CAPITAL, slipBps: SIM_SLIP, start: "new_only" }),
      enabled: sims.has(a),
      staleTime: 5 * 60_000,
      retry: 0,
    })),
  });
  const wallets = qs.map((q) => q.data);
  const ready = wallets.filter((w): w is PlazaWalletDetail => !!w);
  const simOf = (a: string): SimResult | undefined => simQs[addrs.indexOf(a)]?.data;

  // Rank on the plaza (by copy-fit for this window).
  const rank = useMemo(() => {
    const m = new Map<string, number>();
    const list = [...(plaza?.wallets ?? [])].filter((w) => w.analyzed).sort((a, b) => (b.scores[win]?.score ?? 0) - (a.scores[win]?.score ?? 0));
    list.forEach((w, i) => m.set(w.address, i + 1));
    return m;
  }, [plaza, win]);

  const series = useMemo(() => ready.map((w) => ({ key: w.address, points: returns(w, win) })).filter((s) => s.points.length > 1), [ready.map((w) => w.address).join(), win, qs.map((q) => q.dataUpdatedAt).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const winLabel = { "7d": tr("7 天", "7D"), "30d": tr("30 天", "30D"), all: tr("全部", "all time") }[win];
  const rows: Row[] = [
    { key: "score", label: tr("跟单适配度", "Copy-fit"), better: "high", value: (w) => (w.analyzed ? (w.scores[win]?.score ?? null) : null), show: (w) => (w.analyzed ? (w.scores[win]?.score ?? "—") : tr("计算中", "scoring")) },
    { key: "roi", label: tr("收益率", "ROI"), better: "high", value: (w) => w.perf[win]?.roi ?? null, show: (w) => signedPct(w.perf[win]?.roi) },
    { key: "pnl", label: tr("收益额", "PnL"), better: "high", value: (w) => w.perf[win]?.pnl ?? null, show: (w) => (w.perf[win] ? `${w.perf[win]!.pnl >= 0 ? "+" : ""}${usd(w.perf[win]!.pnl)}` : "—") },
    { key: "dd", label: tr("最大回撤", "Max drawdown"), better: "low", value: (w) => (w.analyzed ? (w.max_dd[win] ?? null) : null), show: (w) => (w.analyzed ? pct(w.max_dd[win]) : "—") },
    {
      key: "rdd",
      label: tr("收益 / 回撤", "Return / drawdown"),
      better: "high",
      value: (w) => {
        const r = w.perf[win]?.roi;
        const d = w.max_dd[win];
        return r != null && d != null && d > 0 ? r / d : null;
      },
      show: (w) => {
        const r = w.perf[win]?.roi;
        const d = w.max_dd[win];
        return r != null && d != null && d > 0 ? num(r / d, 2) : "—";
      },
    },
    { key: "win", label: tr("胜率", "Win rate"), better: "high", value: (w) => w.win_rate, show: (w) => pct(w.win_rate, 0) },
    { key: "hold", label: tr("平均持仓", "Avg hold"), better: "high", value: (w) => (w.analyzed ? w.avg_hold_sec : null), show: (w) => (w.analyzed ? holdText(w.avg_hold_sec, en) : "—") },
    { key: "tpd", label: tr("日均成交", "Fills / day"), better: "low", value: (w) => (w.analyzed ? w.trades_per_day : null), show: (w) => (w.analyzed ? num(w.trades_per_day, w.trades_per_day < 10 ? 1 : 0) : "—") },
    { key: "eq", label: tr("账户权益", "Equity"), better: null, value: () => null, show: (w) => usd(w.equity) },
    { key: "coins", label: tr("主要币种", "Main coins"), better: null, value: () => null, show: (w) => (w.coins.length ? w.coins.slice(0, 3).join(en ? ", " : "、") : "—") },
  ];
  const best = (r: Row): string | null => {
    if (!r.better) return null;
    const vs = ready.map((w) => [w.address, r.value(w)] as const).filter((x): x is readonly [string, number] => x[1] != null && Number.isFinite(x[1]));
    if (vs.length < 2) return null;
    const top = vs.reduce((a, b) => ((r.better === "high" ? b[1] > a[1] : b[1] < a[1]) ? b : a));
    // A tie highlights nothing.
    return vs.filter((x) => x[1] === top[1]).length > 1 ? null : top[0];
  };
  const simBest = (() => {
    const vs = addrs.map((a) => [a, simOf(a)?.efficiency] as const).filter((x): x is readonly [string, number] => x[1] != null);
    if (vs.length < 2) return null;
    return vs.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  })();

  // Followable column picked for the phone's bottom button (and highlighted on desktop).
  const followable = (w: PlazaWalletDetail) => !w.task_id && !w.hft;
  const picked = pick && addrs.includes(pick) ? pick : (ready.filter(followable).sort((a, b) => (b.scores[win]?.score ?? 0) - (a.scores[win]?.score ?? 0))[0]?.address ?? null);
  const pickedW = ready.find((w) => w.address === picked);

  if (!addrs.length)
    return (
      <Empty
        title={tr("还没有选择要对比的钱包", "Nothing to compare yet")}
        hint={tr("在跟单员广场勾选 2–4 个钱包后点「开始对比」。", "Tick 2–4 wallets on the plaza, then Compare.")}
        action={
          <Button variant="primary" onClick={() => goTo({ page: "plaza" })}>
            {tr("去跟单员广场", "Open the plaza")}
          </Button>
        }
      />
    );

  const cols = addrs.length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-6 py-5 max-md:gap-4 max-md:px-4 max-md:py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <button onClick={() => goTo({ page: "plaza", addrs })} className="flex items-center gap-1 text-xs text-muted-fg hover:text-fg max-md:hidden">
                <ArrowLeft size={13} />
                {tr("跟单员广场", "Trader plaza")}
              </button>
              <p className="mt-1 text-xs text-muted-fg">{tr(`已选 ${cols} / ${MAX_COMPARE} 个钱包，曲线按各自起点归一为收益率，每行最优值高亮`, `${cols} of ${MAX_COMPARE} wallets; curves are returns from each one's start, best value per row highlighted`)}</p>
            </div>
            <div className="flex items-center gap-2 max-md:w-full">
              <Seg
                value={win}
                onChange={setWin}
                className="max-md:flex-1"
                options={[
                  { value: "7d", label: tr("7 天", "7D") },
                  { value: "30d", label: tr("30 天", "30D") },
                  { value: "all", label: tr("全部", "All") },
                ]}
              />
              <div className="relative">
                <Button disabled={cols >= MAX_COMPARE} onClick={() => setAdding(!adding)}>
                  <Plus size={14} />
                  <span className="max-md:hidden">{tr("添加钱包", "Add wallet")}</span>
                  <span className="md:hidden">{tr("添加", "Add")}</span>
                </Button>
                {adding ? <AddWallet have={addrs} wallets={plaza?.wallets ?? []} win={win} onAdd={(a) => (setAddrs([...addrs, a]), setAdding(false))} onClose={() => setAdding(false)} /> : null}
              </div>
            </div>
          </div>

          <section className="rounded-lg border border-border bg-card p-4 max-md:p-3">
            <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              <h3 className="text-sm font-semibold">{tr("收益率曲线", "Return curves")}</h3>
              {addrs.map((a, i) => (
                <span key={a} className="num flex items-center gap-1.5 text-xs text-muted-fg">
                  <span className="h-0.5 w-4" style={{ background: `var(--series-${i + 1})` }} />
                  {shortAddr(a)}
                </span>
              ))}
            </div>
            {series.length ? (
              <ReturnsChart series={series} height={220} />
            ) : (
              <div className="flex h-[220px] items-center justify-center text-xs text-muted-fg">{qs.some((q) => q.isLoading) ? <Spinner /> : tr("该区间没有曲线数据", "No curve for this window")}</div>
            )}
          </section>

          <section className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[520px] border-collapse text-sm max-md:min-w-0 max-md:text-xs" style={{ tableLayout: "fixed" }}>
              <colgroup>
                <col className="w-[180px] max-md:w-[76px]" />
                {addrs.map((a) => (
                  <col key={a} />
                ))}
              </colgroup>
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left text-xs font-normal text-muted-fg max-md:px-2">
                    <span className="max-md:hidden">{tr(`指标（${winLabel}）`, `Metrics (${winLabel})`)}</span>
                    <span className="md:hidden">{tr("点选跟单", "Tap to pick")}</span>
                  </th>
                  {addrs.map((a, i) => {
                    const w = wallets[i];
                    const q = qs[i];
                    return (
                      <th key={a} className={clsx("px-3 py-3 text-left align-top font-normal max-md:px-1.5", picked === a && "bg-muted/60")}>
                        <div className="flex items-start gap-1">
                          <button className="min-w-0 flex-1 text-left" onClick={() => setPick(a)} aria-pressed={picked === a}>
                            <span className="flex items-center gap-1.5">
                              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--series-${i + 1})` }} />
                              <span className="num truncate text-sm font-semibold max-md:hidden">{w?.name ? label(w) : shortAddr(a)}</span>
                              <span className="num truncate text-[11px] font-semibold md:hidden">{`${a.slice(2, 6)}…${a.slice(-4)}`}</span>
                            </span>
                          </button>
                          <button onClick={() => setAddrs(addrs.filter((x) => x !== a))} className="-mt-1 -mr-1 flex h-7 w-7 shrink-0 items-center justify-center text-muted-fg hover:text-fg max-md:hidden" aria-label={tr("移出对比", "Remove")}>
                            <X size={14} />
                          </button>
                        </div>
                        <div className="mt-1 flex items-center gap-1">
                          <button className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-left" onClick={() => setPick(a)} tabIndex={-1}>
                            {q.isLoading ? (
                              <Spinner />
                            ) : q.error ? (
                              <span className="text-xs text-danger">{tr("加载失败", "Failed")}</span>
                            ) : w?.task_id ? (
                              <span className="bg-success-soft px-1.5 text-xs whitespace-nowrap text-success">{tr("跟单中", "Copying")}</span>
                            ) : w?.favorite ? (
                              <span className="inline-flex items-center gap-1 bg-primary-soft px-1.5 text-xs whitespace-nowrap text-primary">
                                <Star size={10} className="fill-primary" />
                                {tr("已关注", "Starred")}
                              </span>
                            ) : rank.get(a) ? (
                              <span className="bg-muted px-1.5 text-xs whitespace-nowrap text-muted-fg">
                                <span className="max-md:hidden">{tr("排行榜 ", "Rank ")}</span>#{rank.get(a)}
                              </span>
                            ) : null}
                            {w?.hft ? <span className="bg-primary-soft px-1.5 text-xs whitespace-nowrap text-warning">{tr("高频", "HFT")}</span> : null}
                          </button>
                          <button onClick={() => setAddrs(addrs.filter((x) => x !== a))} className="-my-1 flex h-6 w-6 shrink-0 items-center justify-center text-muted-fg hover:text-fg md:hidden" aria-label={tr("移出对比", "Remove")}>
                            <X size={13} />
                          </button>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const b = best(r);
                  return (
                    <tr key={r.key} className="border-b border-border">
                      <td className="px-4 py-2.5 text-muted-fg max-md:px-2">{r.label}</td>
                      {addrs.map((a, i) => {
                        const w = wallets[i];
                        const tone = r.key === "roi" || r.key === "pnl" ? ((w?.perf[win]?.pnl ?? 0) >= 0 ? "text-success" : "text-danger") : r.key === "dd" && (w?.max_dd[win] ?? 0) > 0.25 ? "text-warning" : undefined;
                        return (
                          <td key={a} className={clsx("px-3 py-2.5 max-md:px-1.5", r.key !== "coins" && "num", b === a ? "bg-primary-soft font-semibold text-primary" : tone, r.key === "coins" && "truncate")}>
                            {w ? r.show(w) : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr className="border-b border-border">
                  <td className="px-4 py-2.5 align-top max-md:px-2">
                    <div className="text-muted-fg">{tr("模拟跟单", "Simulated copy")}</div>
                    <div className="num text-xs text-muted-fg max-md:hidden">{tr(`${num(SIM_CAPITAL, 0)} USDT，滑点 ${SIM_SLIP} bp`, `${num(SIM_CAPITAL, 0)} USDT, ${SIM_SLIP} bp slippage`)}</div>
                  </td>
                  {addrs.map((a, i) => {
                    const sq = simQs[i];
                    const r = sq?.data;
                    return (
                      <td key={a} className={clsx("px-3 py-2.5 align-top max-md:px-1.5", simBest === a && "bg-primary-soft")}>
                        {r && r.considered === 0 ? (
                          <div className="text-xs text-muted-fg">{r.unsupported.length ? tr("只交易 HIP-3 市场，无可跟成交", "Only HIP-3 markets; nothing to copy") : tr("区间内无可跟成交", "Nothing to copy")}</div>
                        ) : r ? (
                          <>
                            <div className={clsx("num font-semibold", simBest === a ? "text-primary" : r.roi >= 0 ? "text-success" : "text-danger")}>{signedPct(r.roi)}</div>
                            <div className="text-xs text-muted-fg">
                              <span className="max-md:hidden">{tr(`跟随效率 ${r.efficiency != null ? pct(r.efficiency, 0) : "—"}，${r.trades} 笔`, `efficiency ${r.efficiency != null ? pct(r.efficiency, 0) : "—"}, ${r.trades} fills`)}</span>
                              <span className="md:hidden">{tr(`效率 ${r.efficiency != null ? pct(r.efficiency, 0) : "—"}`, `eff. ${r.efficiency != null ? pct(r.efficiency, 0) : "—"}`)}</span>
                            </div>
                          </>
                        ) : sq?.isFetching ? (
                          <Spinner />
                        ) : sq?.error ? (
                          <div className="text-xs text-danger" title={errMsg(sq.error)}>
                            {tr("模拟失败", "Failed")}
                          </div>
                        ) : (
                          <Button size="sm" disabled={!wallets[i]} onClick={() => setSims((cur) => new Set([...cur, a]))}>
                            {tr("运行模拟", "Simulate")}
                          </Button>
                        )}
                      </td>
                    );
                  })}
                </tr>
                <tr className="max-md:hidden">
                  <td className="px-4 py-3" />
                  {addrs.map((a, i) => (
                    <td key={a} className="px-3 py-3">
                      {wallets[i] ? <FollowButton w={wallets[i]!} primary={picked === a} /> : null}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </section>
          <p className="text-xs text-muted-fg max-md:hidden">
            {tr("高亮规则：收益、胜率、适配度越高越好；回撤与日均成交越低越好；平均持仓越长越容易跟上。模拟结果按跟随效率比较。权益和币种只展示不排名。", "Highlighting: higher return, win rate and copy-fit are better; lower drawdown and fills per day are better; longer holds are easier to follow. Simulations compare on efficiency. Equity and coins are not ranked.")}
          </p>
          <p className="text-xs text-muted-fg md:hidden">{tr("黄色为每行最优值。回撤与日均成交越低越好，平均持仓越长越容易跟上。", "Yellow marks each row's best. Lower drawdown and fills per day are better; longer holds are easier to follow.")}</p>
        </div>
      </div>
      {pickedW ? (
        <div className="border-t border-border bg-card px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:hidden">
          <FollowButton w={pickedW} primary full />
        </div>
      ) : null}
    </div>
  );
}

function FollowButton({ w, primary, full }: { w: PlazaWalletDetail; primary: boolean; full?: boolean }) {
  const tr = useTr();
  const { go, toast } = useUi();
  const [busy, setBusy] = useState(false);
  if (w.task_id)
    return (
      <Button className={clsx(full ? "h-11 w-full" : "w-full")} onClick={() => go("task", w.task_id!)}>
        {tr("查看任务", "View task")}
      </Button>
    );
  return (
    <Button
      variant={primary ? "primary" : "outline"}
      className={clsx(full ? "h-11 w-full text-md" : "w-full")}
      disabled={w.hft}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          let sid = w.source_id;
          if (!sid) {
            sid = await api.addSource({ kind: "hl_address", name: w.name ?? `HL ${shortAddr(w.address)}`, address: w.address, testnet: false });
            qc.invalidateQueries({ queryKey: ["sources"] });
            qc.invalidateQueries({ queryKey: ["plaza"] });
            qc.invalidateQueries({ queryKey: ["plaza-wallet", w.address] });
          }
          go("wizard", undefined, sid);
        } catch (e) {
          toast(errMsg(e), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      {w.hft ? tr("高频不支持跟单", "HFT, not copyable") : full ? tr(`跟单 ${shortAddr(w.address)}`, `Copy ${shortAddr(w.address)}`) : tr("跟单这个钱包", "Copy this wallet")}
    </Button>
  );
}

function AddWallet({ have, wallets, win, onAdd, onClose }: { have: string[]; wallets: PlazaWallet[]; win: PlazaWindow; onAdd: (a: string) => void; onClose: () => void }) {
  const tr = useTr();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const ok = isAddr(needle) && !have.includes(needle);
  // Starred first, then the best copy-fit.
  const picks = wallets
    .filter((w) => !have.includes(w.address) && (!needle || w.address.includes(needle) || (w.name ?? "").toLowerCase().includes(needle)))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.scores[win]?.score ?? 0) - (a.scores[win]?.score ?? 0))
    .slice(0, 6);
  // Make sure a pasted address resolves before adding (a typo would show as a failed column).
  const probe = useQuery({ queryKey: ["plaza-wallet", needle], queryFn: () => api.plazaWallet(needle), enabled: ok && !wallets.some((w) => w.address === needle), staleTime: 30_000, retry: 0 });
  return (
    <>
      <div className="fixed inset-0 z-20" onMouseDown={onClose} />
      <div className="anim-fade absolute right-0 z-30 mt-2 w-[320px] max-w-[calc(100vw-32px)] rounded-lg border border-border bg-card p-3 shadow-[0_12px_32px_rgba(0,0,0,0.35)]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onAdd(needle);
          }}
        >
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("搜索广场，或粘贴 0x 地址", "Search, or paste a 0x address")} className="num h-9 w-full rounded-md border border-input bg-bg px-3 text-sm outline-none focus:border-ring" />
        </form>
        <div className="mt-2 flex flex-col">
          {ok ? (
            <button onClick={() => onAdd(needle)} className="flex items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-muted">
              <span className="num">{shortAddr(needle)}</span>
              <span className="text-xs text-muted-fg">{probe.isFetching ? <Spinner /> : probe.error ? tr("地址无数据", "No data") : tr("添加", "Add")}</span>
            </button>
          ) : null}
          {picks.map((w) => (
            <button key={w.address} onClick={() => onAdd(w.address)} className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted">
              {w.favorite ? <Star size={12} className="shrink-0 fill-primary text-primary" /> : <span className="w-3" />}
              <span className="num min-w-0 flex-1 truncate">{label(w)}</span>
              <span className={clsx("num text-xs", (w.perf[win]?.roi ?? 0) >= 0 ? "text-success" : "text-danger")}>{signedPct(w.perf[win]?.roi)}</span>
              <span className="num w-8 text-right text-xs text-muted-fg">{w.analyzed ? (w.scores[win]?.score ?? "—") : "…"}</span>
            </button>
          ))}
          {!ok && !picks.length ? <div className="px-2 py-3 text-xs text-muted-fg">{tr("没有匹配的钱包", "No match")}</div> : null}
        </div>
        <p className="mt-2 px-2 text-xs text-muted-fg">{tr(`最多对比 ${MAX_COMPARE} 个钱包`, `Up to ${MAX_COMPARE} wallets`)}</p>
      </div>
    </>
  );
}
