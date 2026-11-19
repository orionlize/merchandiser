import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, Check, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Checkbox, Confirm, Field, Input, Loading, NumInput, PlatformTag, Radio, Seg, Spinner, Toggle } from "../components/ui";
import { api, errMsg, type FollowerSpec, type Risk, type Rules } from "../lib/api";
import { num, shortAddr } from "../lib/format";
import { useTr } from "../lib/i18n";
import { qc, useConnections, useSources, useTask } from "../lib/queries";
import { useUi } from "../lib/store";

const DEFAULT_RULES: Rules = {
  sizing: { mode: "equity_ratio", k: "1", notional: "500" },
  leverage: { mode: "follow", value: 5, cap: 10 },
  whitelist: [],
  blacklist: [],
  direction: "both",
  reverse: false,
  start: "new_only",
  stop: "keep",
  min_change_usdt: "10",
  exec: "market",
  mirror: { enabled: true, grace_ms: 2000, max_deviation_pct: "5" },
  reconcile_secs: 15,
  tolerance_pct: "2",
  reconcile_mode: "auto_fix",
};

const DEFAULT_RISK: Risk = {
  max_symbol_notional: null,
  max_total_notional: null,
  max_slippage_pct: "0.3",
  daily_loss_limit: null,
  total_loss_limit: null,
  close_on_loss: false,
  source_lost_secs: 30,
  source_lost_action: "keep",
};

type Step = 0 | 1 | 2 | 3 | 4;

export function Wizard() {
  const tr = useTr();
  const { route, go, toast } = useUi();
  const editId = route.id;
  const { data: existing, isLoading: loadingTask } = useTask(editId);
  const { data: sources } = useSources();
  const { data: conns } = useConnections();
  const [step, setStep] = useState<Step>(0);
  const [sourceId, setSourceId] = useState<string>("");
  const [followers, setFollowers] = useState<FollowerSpec[]>([]);
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [risk, setRisk] = useState<Risk>(DEFAULT_RISK);
  const [name, setName] = useState("");
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (existing && !loaded) {
      setSourceId(existing.source_id);
      setFollowers(existing.followers.map((f) => ({ connection_id: f.connection_id, overrides: f.overrides })));
      setRules({ ...DEFAULT_RULES, ...existing.rules });
      setRisk({ ...DEFAULT_RISK, ...existing.risk });
      setName(existing.name);
      setStep(2);
      setLoaded(true);
    }
  }, [existing, loaded]);

  const source = sources?.find((s) => s.id === sourceId);
  // OKX lead traders publish no equity, and hidden Binance traders report one
  // that does not match their positions: equity-ratio sizing is unavailable.
  const noSourceEquity = source?.kind === "lead_trader" && (source.platform === "okx" || source.lead_mode === "fills");
  useEffect(() => {
    if (noSourceEquity && rules.sizing.mode === "equity_ratio") setRules((r) => ({ ...r, sizing: { ...r.sizing, mode: "fixed_multiple" } }));
  }, [noSourceEquity, rules.sizing.mode]);
  const eligible = (conns ?? []).filter((c) => c.id !== source?.connection_id && (c.platform === "paper" || c.perms?.trade));

  useEffect(() => {
    if (!editId && source && !name) setName(source.kind === "hl_address" ? `${source.name}` : `${source.name} 跟单`);
  }, [source, editId, name]);

  const kInvalid = rules.sizing.mode !== "fixed_notional" && (!(Number(rules.sizing.k) >= 0.1) || Number(rules.sizing.k) > 10);
  const nInvalid = rules.sizing.mode === "fixed_notional" && !(Number(rules.sizing.notional) > 0);
  const capInvalid = !(rules.leverage.cap >= 1);
  const canNext = [!!sourceId, followers.length > 0, !kInvalid && !nInvalid && !capInvalid, Number(risk.max_slippage_pct) > 0, !!name.trim()][step];

  const previewKey = JSON.stringify({ sourceId, followers, sizing: rules.sizing, bl: rules.blacklist, wl: rules.whitelist, dir: rules.direction, rev: rules.reverse });
  const preview = useQuery({
    queryKey: ["preview", previewKey],
    queryFn: () => api.preview({ source_id: sourceId, followers, rules }),
    enabled: !!sourceId && followers.length > 0 && step >= 1 && !kInvalid && !nInvalid,
    staleTime: 15000,
    retry: 0,
  });

  const steps = [tr("信号源", "Source"), tr("跟单账户", "Followers"), tr("设规则", "Rules"), tr("风控", "Risk"), tr("确认", "Confirm")];
  const nextLabel = step < 4 ? tr(`下一步：${steps[step + 1]}`, `Next: ${steps[step + 1]}`) : editId ? tr("保存修改", "Save changes") : startNow ? tr("创建并启动", "Create and start") : tr("创建任务", "Create task");

  // Hidden-position lead traders need an explicit second confirmation.
  const [confirmFills, setConfirmFills] = useState(false);
  const fillsSource = source?.kind === "lead_trader" && source.lead_mode === "fills";
  const submit = async () => {
    setConfirmFills(false);
    setBusy(true);
    try {
      if (editId) {
        await api.updateTask(editId, { name, rules, risk, followers });
        toast(tr("规则已更新，任务将按新规则对账", "Rules updated; the task reconciles under the new rules"));
        qc.invalidateQueries({ queryKey: ["task"] });
        go("task", editId);
      } else {
        const id = await api.createTask({ name, source_id: sourceId, followers, rules, risk, start_now: startNow });
        toast(startNow ? tr("任务已创建并启动", "Task created and started") : tr("任务已创建", "Task created"));
        qc.invalidateQueries({ queryKey: ["tasks"] });
        go("task", id);
      }
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  if (editId && loadingTask) return <Loading />;

  return (
    <div className="flex h-full flex-col">
      <Confirm
        open={confirmFills}
        onClose={() => setConfirmFills(false)}
        title={tr("确认跟随未公开持仓的带单员？", "Follow a trader with hidden positions?")}
        confirmLabel={startNow ? tr("确认跟单并启动", "Follow and start") : tr("确认创建", "Create")}
        busy={busy}
        onConfirm={submit}
        body={
          <div className="flex flex-col gap-2 text-sm">
            <p>{tr(`信号源「${source?.name ?? ""}」没有公开持仓，任务将按他公开的成交记录推算仓位跟单：`, `Source "${source?.name ?? ""}" hides positions; this task follows positions reconstructed from public fills:`)}</p>
            <ul className="list-disc pl-5 text-muted-fg">
              <li>{tr("比带单员晚约 2 分钟，成交价会与他不同；超过「单笔最大滑点」的开仓会被跳过。", "About 2 minutes behind; fill prices will differ. Opens beyond the max slippage are skipped.")}</li>
              <li>{tr("只跟信号源添加之后新开的仓位；杠杆未知，「跟随信号源杠杆」改用固定值。", "Only positions opened after the source was added; leverage is unknown, so the fixed value is used.")}</li>
              <li>{tr("推算可能与真实持仓不同，请控制跟单规模。", "The reconstruction may differ from the real positions; size accordingly.")}</li>
            </ul>
          </div>
        }
      />
      {/* Stepper */}
      <div className="flex h-[52px] shrink-0 items-center gap-4 overflow-x-auto border-b border-border px-4 md:px-6">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center gap-4">
            <button disabled={i > step && !canNext} onClick={() => i <= step && setStep(i as Step)} className="flex items-center gap-2">
              {i < step ? (
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-muted-fg text-muted-fg">
                  <Check size={11} />
                </span>
              ) : (
                <span className={clsx("flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px]", i === step ? "bg-primary font-semibold text-on-primary" : "border border-border text-muted-fg")}>{i + 1}</span>
              )}
              <span className={clsx("text-sm whitespace-nowrap", i === step ? "font-semibold" : "text-muted-fg max-md:hidden")}>{s}</span>
            </button>
            {i < steps.length - 1 ? <span className="h-px w-10 bg-border max-md:w-4" /> : null}
          </div>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 max-lg:flex-col max-lg:overflow-y-auto">
        <div key={step} className="anim-rise min-w-0 flex-1 px-4 py-5 md:px-12 md:py-7 lg:overflow-y-auto">
          {step === 0 ? (
            <SourceStep sourceId={sourceId} setSourceId={setSourceId} disabled={!!editId} />
          ) : step === 1 ? (
            <FollowerStep eligible={eligible} followers={followers} setFollowers={setFollowers} />
          ) : step === 2 ? (
            <RulesStep rules={rules} setRules={setRules} kInvalid={kInvalid} nInvalid={nInvalid} supportsMirror={source?.kind !== "lead_trader"} noSourceEquity={noSourceEquity} />
          ) : step === 3 ? (
            <RiskStep risk={risk} setRisk={setRisk} rules={rules} setRules={setRules} />
          ) : (
            <ConfirmStep name={name} setName={setName} startNow={startNow} setStartNow={setStartNow} editing={!!editId} followers={followers} setFollowers={setFollowers} rules={rules} conns={conns ?? []} />
          )}
        </div>
        <PreviewPanel loading={preview.isFetching} data={preview.data} error={preview.error ? errMsg(preview.error) : null} sourceLabel={source ? (source.kind === "hl_address" ? `HL ${shortAddr(source.address)}` : source.name) : ""} empty={!sourceId || followers.length === 0} />
      </div>
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-t border-border px-4 md:px-6">
        <Button variant="ghost" onClick={() => (editId ? go("task", editId) : go("tasks"))}>
          {tr("取消", "Cancel")}
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-fg max-md:hidden">{canNext ? [tr("已选信号源", "Source selected"), tr(`已选 ${followers.length} 个账户`, `${followers.length} selected`), tr("规则已填完", "Rules complete"), tr("风控已填完", "Risk complete"), tr("可以创建", "Ready")][step] : tr("请完成必填项", "Complete required fields")}</span>
          <Button disabled={step === 0} onClick={() => setStep((s) => (s - 1) as Step)}>
            {tr("上一步", "Back")}
          </Button>
          <Button variant="primary" disabled={!canNext} loading={busy} onClick={() => (step < 4 ? setStep((s) => (s + 1) as Step) : !editId && fillsSource ? setConfirmFills(true) : submit())}>
            {nextLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function H({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="text-md font-semibold">{children}</h3>
      {hint ? <p className="mt-1 text-xs text-muted-fg">{hint}</p> : null}
    </div>
  );
}

function SourceStep({ sourceId, setSourceId, disabled }: { sourceId: string; setSourceId: (s: string) => void; disabled: boolean }) {
  const tr = useTr();
  const { go } = useUi();
  const { data: sources } = useSources();
  return (
    <div className="max-w-[640px]">
      <H hint={tr("选择要跟随的对象。添加新的信号源请到「信号源」页。", "Choose who to follow. Add new sources on the Sources page.")}>{tr("选择信号源", "Choose a source")}</H>
      {!sources?.length ? (
        <div className="rounded-lg border border-border p-6 text-sm text-muted-fg">
          {tr("还没有信号源。", "No sources yet.")}{" "}
          <Button variant="link" onClick={() => go("sources")}>
            {tr("去添加", "Add one")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sources.map((s) => (
            <button
              key={s.id}
              disabled={disabled}
              onClick={() => setSourceId(s.id)}
              className={clsx("flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-[border-color,background-color] duration-150 disabled:cursor-not-allowed", sourceId === s.id ? "border-fg bg-muted" : "border-border hover:bg-muted/50")}
            >
              <PlatformTag platform={s.platform} testnet={s.testnet} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{s.name}</div>
                <div className="num mt-0.5 truncate text-xs text-muted-fg">{s.kind === "hl_address" ? s.address : s.kind === "lead_trader" ? `${tr("带单员", "Lead trader")} · ${s.address}${s.lead_mode === "fills" ? tr(" · 成交推算（晚约 2 分钟）", " · from fills (~2 min behind)") : ""}` : s.platform === "paper" ? `${tr("模拟账户", "Paper account")} · ${s.connection_alias}` : `${tr("只读 API", "Read-only API")} · ${s.connection_alias}`}</div>
              </div>
              <span className="text-xs text-muted-fg">{s.task_count ? tr(`${s.task_count} 个任务`, `${s.task_count} tasks`) : ""}</span>
            </button>
          ))}
        </div>
      )}
      {disabled ? <p className="mt-3 text-xs text-muted-fg">{tr("已有任务不能更换信号源；如需更换请新建任务。", "A task's source cannot change; create a new task instead.")}</p> : null}
    </div>
  );
}

function FollowerStep({ eligible, followers, setFollowers }: { eligible: ReturnType<typeof useConnections>["data"]; followers: FollowerSpec[]; setFollowers: (f: FollowerSpec[]) => void }) {
  const tr = useTr();
  const { go } = useUi();
  const sel = new Set(followers.map((f) => f.connection_id));
  return (
    <div className="max-w-[640px]">
      <H hint={tr("只列出具备合约交易权限的连接与模拟账户。跟单账户须为单向持仓。", "Only trade-enabled connections and paper accounts are listed. Followers must use one-way mode.")}>{tr("选择跟单账户", "Choose follower accounts")}</H>
      {!eligible?.length ? (
        <div className="rounded-lg border border-border p-6 text-sm text-muted-fg">
          {tr("没有可用的跟单账户。", "No eligible accounts.")}{" "}
          <Button variant="link" onClick={() => go("connections")}>
            {tr("添加连接", "Add a connection")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {eligible.map((c) => (
            <div key={c.id} className={clsx("flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors duration-150", sel.has(c.id) ? "border-fg bg-muted" : "border-border")}>
              <Checkbox checked={sel.has(c.id)} onChange={(v) => setFollowers(v ? [...followers, { connection_id: c.id }] : followers.filter((f) => f.connection_id !== c.id))} />
              <PlatformTag platform={c.platform} testnet={c.testnet} />
              <span className="flex-1 text-sm">{c.alias}</span>
              {c.one_way === false ? (
                <span className="flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle size={12} />
                  {tr("双向持仓，需切换", "Hedge mode — switch first")}
                </span>
              ) : null}
              <span className="num w-32 text-right text-sm">{num(c.equity)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RulesStep({ rules, setRules, kInvalid, nInvalid, supportsMirror, noSourceEquity }: { rules: Rules; setRules: (r: Rules) => void; kInvalid: boolean; nInvalid: boolean; supportsMirror: boolean; noSourceEquity: boolean }) {
  const tr = useTr();
  const [newSym, setNewSym] = useState("");
  const [adding, setAdding] = useState(false);
  const set = (p: Partial<Rules>) => setRules({ ...rules, ...p });
  const modes = [
    { v: "equity_ratio" as const, t: tr("按权益比例", "Equity ratio"), d: tr("跟单权益 ÷ 信号源权益 × 倍数", "Follower ÷ source equity × k") },
    { v: "fixed_multiple" as const, t: tr("固定倍数", "Fixed multiple"), d: tr("信号源数量 × k", "Source qty × k") },
    { v: "fixed_notional" as const, t: tr("固定名义金额", "Fixed notional"), d: tr("每次开仓固定 USDT", "Fixed USDT per open") },
  ];
  return (
    <div className="flex max-w-[600px] flex-col gap-8">
      <section>
        <H>{tr("仓位计算", "Position sizing")}</H>
        <div className="grid grid-cols-3 gap-2">
          {modes.map((m) => (
            <button
              key={m.v}
              disabled={noSourceEquity && m.v === "equity_ratio"}
              title={noSourceEquity && m.v === "equity_ratio" ? tr("信号源权益未知", "Source equity unknown") : undefined}
              onClick={() => set({ sizing: { ...rules.sizing, mode: m.v } })}
              className={clsx("rounded-md border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-40", rules.sizing.mode === m.v ? "border-fg bg-muted" : "border-border hover:bg-muted/50")}
            >
              <div className="text-sm font-semibold">{m.t}</div>
              <div className="mt-0.5 text-xs text-muted-fg">{m.d}</div>
            </button>
          ))}
        </div>
        <div className="mt-4 w-40">
          {rules.sizing.mode === "fixed_notional" ? (
            <Field label={tr("每次开仓金额", "Per open")} error={nInvalid ? tr("请填写大于 0 的金额", "Enter an amount above 0") : null}>
              <NumInput value={rules.sizing.notional} onChange={(v) => set({ sizing: { ...rules.sizing, notional: v } })} suffix="USDT" invalid={nInvalid} />
            </Field>
          ) : (
            <Field label={rules.sizing.mode === "equity_ratio" ? tr("权益倍数", "Equity multiple") : tr("倍数 k", "Multiple k")} error={kInvalid ? tr("请填写倍数，范围 0.1–10。", "Enter a multiple between 0.1 and 10.") : null}>
              <NumInput value={rules.sizing.k} onChange={(v) => set({ sizing: { ...rules.sizing, k: v } })} invalid={kInvalid} />
            </Field>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-fg">{tr("每个跟单账户可在确认页单独覆盖。", "Each follower can override this on the confirm step.")}</p>
        {noSourceEquity ? <p className="mt-1 text-xs text-muted-fg">{tr("OKX 带单员不公开自身权益，隐藏持仓的币安带单员公布的权益与持仓对不上，「按权益比例」不可用。固定倍数按带单员的币数乘以 k。", "OKX lead traders do not publish equity, and hidden Binance traders report an equity that does not match their positions, so equity ratio is unavailable. Fixed multiple uses the trader's coin size × k.")}</p> : null}
      </section>

      <section className="grid grid-cols-2 gap-8">
        <div>
          <H>{tr("杠杆", "Leverage")}</H>
          <div className="flex items-center gap-3">
            <Seg
              value={rules.leverage.mode}
              onChange={(v) => set({ leverage: { ...rules.leverage, mode: v } })}
              options={[
                { value: "follow", label: tr("跟随信号源", "Follow source") },
                { value: "fixed", label: tr("固定值", "Fixed") },
              ]}
            />
            {rules.leverage.mode === "fixed" ? <NumInput className="w-20" value={String(rules.leverage.value)} onChange={(v) => set({ leverage: { ...rules.leverage, value: Number(v) || 1 } })} suffix="×" /> : null}
            <span className="text-xs text-muted-fg">{tr("上限", "Cap")}</span>
            <NumInput className="w-20" value={String(rules.leverage.cap || "")} onChange={(v) => set({ leverage: { ...rules.leverage, cap: Number(v) || 0 } })} suffix="×" />
          </div>
        </div>
        <div>
          <H>{tr("挂单镜像", "Order mirroring")}</H>
          {supportsMirror ? (
            <Toggle checked={rules.mirror.enabled} onChange={(v) => set({ mirror: { ...rules.mirror, enabled: v } })} label={tr("同步限价单与止盈止损", "Mirror limit and TP/SL orders")} />
          ) : (
            <span className="text-sm text-muted-fg">{tr("该信号源不公开挂单，只做仓位跟随", "Source does not expose orders")}</span>
          )}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-8">
        <div>
          <H>{tr("启动时", "On start")}</H>
          <Radio checked={rules.start === "new_only"} onChange={() => set({ start: "new_only" })} label={tr("只跟新开仓位", "Follow new positions only")} />
          <Radio checked={rules.start === "sync_existing"} onChange={() => set({ start: "sync_existing" })} label={tr("立即同步信号源已有持仓", "Sync the source's existing positions now")} hint={tr("启动后将立即以市价开出右侧预览中的仓位。", "Opens the positions in the preview at market right after start.")} />
        </div>
        <div>
          <H>{tr("停止时", "On stop")}</H>
          <Radio checked={rules.stop === "keep"} onChange={() => set({ stop: "keep" })} label={tr("保留已跟仓位", "Keep positions")} />
          <Radio checked={rules.stop === "close_all"} onChange={() => set({ stop: "close_all" })} label={tr("市价全部平掉", "Close at market")} />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-8">
        <div>
          <H>{rules.whitelist.length ? tr("品种白名单", "Coin allow-list") : tr("品种黑名单", "Coin block-list")}</H>
          <div className="flex flex-wrap items-center gap-2">
            {rules.blacklist.map((b) => (
              <span key={b} className="num inline-flex h-7 items-center gap-1.5 bg-muted px-2 text-xs">
                {b}
                <button onClick={() => set({ blacklist: rules.blacklist.filter((x) => x !== b) })} className="text-muted-fg hover:text-fg">
                  <X size={12} />
                </button>
              </span>
            ))}
            {adding ? (
              <input
                autoFocus
                value={newSym}
                onChange={(e) => setNewSym(e.target.value.toUpperCase())}
                onBlur={() => setAdding(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newSym.trim()) {
                    set({ blacklist: Array.from(new Set([...rules.blacklist, newSym.trim().replace(/^(1000|K)/, "")])) });
                    setNewSym("");
                    setAdding(false);
                  }
                  if (e.key === "Escape") setAdding(false);
                }}
                placeholder="PEPE"
                className="num h-7 w-24 border border-input bg-bg px-2 text-xs outline-none"
              />
            ) : (
              <Button variant="link" className="text-xs" onClick={() => setAdding(true)}>
                {tr("添加品种", "Add coin")}
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-fg">{tr("按基础币种填写，如 PEPE（自动覆盖 1000PEPE / kPEPE）。", "Use the base coin, e.g. PEPE (covers 1000PEPE / kPEPE).")}</p>
        </div>
        <div>
          <H>{tr("最小变动阈值", "Minimum change")}</H>
          <NumInput className="w-28" value={rules.min_change_usdt} onChange={(v) => set({ min_change_usdt: v })} suffix="USDT" />
          <p className="mt-2 text-xs text-muted-fg">{tr("差额低于此值或最小下单量时不动作，累计到阈值再补。", "Smaller gaps wait until they add up.")}</p>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-8">
        <div>
          <H>{tr("方向", "Direction")}</H>
          <Seg
            value={rules.direction}
            onChange={(v) => set({ direction: v })}
            options={[
              { value: "both", label: tr("双向", "Both") },
              { value: "long_only", label: tr("只跟多", "Long only") },
              { value: "short_only", label: tr("只跟空", "Short only") },
            ]}
          />
          <div className="mt-3">
            <Toggle checked={rules.reverse} onChange={(v) => set({ reverse: v })} label={tr("反向跟单", "Reverse")} />
          </div>
        </div>
        <div>
          <H>{tr("下单方式", "Order type")}</H>
          <Seg
            value={rules.exec}
            onChange={(v) => set({ exec: v })}
            options={[
              { value: "market", label: tr("市价单", "Market") },
              { value: "limit_ioc", label: tr("限价 IOC（滑点上限）", "Limit IOC (slip-capped)") },
            ]}
          />
        </div>
      </section>
    </div>
  );
}

function RiskStep({ risk, setRisk, rules, setRules }: { risk: Risk; setRisk: (r: Risk) => void; rules: Rules; setRules: (r: Rules) => void }) {
  const tr = useTr();
  const set = (p: Partial<Risk>) => setRisk({ ...risk, ...p });
  const opt = (v: string) => (v.trim() === "" ? null : v);
  return (
    <div className="flex max-w-[600px] flex-col gap-8">
      <section>
        <H hint={tr("超出上限的部分跳过并记日志；留空表示不限。", "Anything beyond a cap is skipped and logged. Leave empty for no cap.")}>{tr("仓位上限", "Position caps")}</H>
        <div className="grid grid-cols-2 gap-4">
          <Field label={tr("单品种最大名义仓位", "Max notional per coin")}>
            <NumInput value={risk.max_symbol_notional ?? ""} onChange={(v) => set({ max_symbol_notional: opt(v) })} suffix="USDT" placeholder={tr("不限", "None")} />
          </Field>
          <Field label={tr("账户总名义仓位上限", "Max total notional per account")}>
            <NumInput value={risk.max_total_notional ?? ""} onChange={(v) => set({ max_total_notional: opt(v) })} suffix="USDT" placeholder={tr("不限", "None")} />
          </Field>
        </div>
      </section>
      <section>
        <H hint={tr("下单前比对信号源价格与目标平台盘口，偏离超限则本次不跟（减仓与平仓不受限）。", "Compares the source price with the follower's book before opening; skip when beyond. Reductions are never blocked.")}>{tr("单笔最大滑点", "Max slippage per order")}</H>
        <NumInput className="w-32" value={risk.max_slippage_pct} onChange={(v) => set({ max_slippage_pct: v })} suffix="%" invalid={!(Number(risk.max_slippage_pct) > 0)} />
      </section>
      <section>
        <H hint={tr("触发后暂停任务并通知，需手动恢复。", "When hit, the task pauses and notifies you; resume manually.")}>{tr("亏损上限", "Loss limits")}</H>
        <div className="grid grid-cols-2 gap-4">
          <Field label={tr("日亏损上限", "Daily loss limit")}>
            <NumInput value={risk.daily_loss_limit ?? ""} onChange={(v) => set({ daily_loss_limit: opt(v) })} suffix="USDT" placeholder={tr("不限", "None")} />
          </Field>
          <Field label={tr("任务累计亏损上限", "Total loss limit")}>
            <NumInput value={risk.total_loss_limit ?? ""} onChange={(v) => set({ total_loss_limit: opt(v) })} suffix="USDT" placeholder={tr("不限", "None")} />
          </Field>
        </div>
        <div className="mt-3">
          <Toggle checked={risk.close_on_loss} onChange={(v) => set({ close_on_loss: v })} label={tr("触发时同时市价平仓", "Also close positions at market")} />
        </div>
      </section>
      <section>
        <H>{tr("信号源失联", "Source lost")}</H>
        <div className="flex items-center gap-3">
          <span className="text-sm">{tr("超过", "After")}</span>
          <NumInput className="w-24" value={String(risk.source_lost_secs)} onChange={(v) => set({ source_lost_secs: Number(v) || 0 })} suffix={tr("秒", "s")} />
          <Seg
            value={risk.source_lost_action}
            onChange={(v) => set({ source_lost_action: v })}
            options={[
              { value: "keep", label: tr("保持", "Keep") },
              { value: "pause", label: tr("暂停", "Pause") },
              { value: "close", label: tr("平仓", "Close") },
            ]}
          />
        </div>
      </section>
      <section>
        <H hint={tr("对账循环定时比对目标与实际仓位，超出容差时处理。", "The reconcile loop compares target and actual on a timer.")}>{tr("对账", "Reconciliation")}</H>
        <div className="flex items-center gap-3">
          <span className="text-sm">{tr("每", "Every")}</span>
          <NumInput className="w-20" value={String(rules.reconcile_secs)} onChange={(v) => setRules({ ...rules, reconcile_secs: Number(v) || 15 })} suffix={tr("秒", "s")} />
          <span className="text-sm">{tr("容差", "tolerance")}</span>
          <NumInput className="w-20" value={rules.tolerance_pct} onChange={(v) => setRules({ ...rules, tolerance_pct: v })} suffix="%" />
          <Seg
            value={rules.reconcile_mode}
            onChange={(v) => setRules({ ...rules, reconcile_mode: v })}
            options={[
              { value: "auto_fix", label: tr("自动补单", "Auto-fix") },
              { value: "alert_only", label: tr("仅告警", "Alert only") },
            ]}
          />
        </div>
        {rules.mirror.enabled ? (
          <div className="mt-4 flex items-center gap-3">
            <span className="text-sm">{tr("镜像宽限期", "Mirror grace")}</span>
            <NumInput className="w-24" value={String(rules.mirror.grace_ms / 1000)} onChange={(v) => setRules({ ...rules, mirror: { ...rules.mirror, grace_ms: Math.round((Number(v) || 0) * 1000) } })} suffix={tr("秒", "s")} />
            <span className="text-sm">{tr("偏离盘口超过", "Skip beyond")}</span>
            <NumInput className="w-20" value={rules.mirror.max_deviation_pct} onChange={(v) => setRules({ ...rules, mirror: { ...rules.mirror, max_deviation_pct: v } })} suffix="%" />
            <span className="text-sm">{tr("不镜像", "from book")}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ConfirmStep({ name, setName, startNow, setStartNow, editing, followers, setFollowers, rules, conns }: { name: string; setName: (s: string) => void; startNow: boolean; setStartNow: (b: boolean) => void; editing: boolean; followers: FollowerSpec[]; setFollowers: (f: FollowerSpec[]) => void; rules: Rules; conns: NonNullable<ReturnType<typeof useConnections>["data"]> }) {
  const tr = useTr();
  const setOverride = (id: string, k: string | null) =>
    setFollowers(followers.map((f) => (f.connection_id === id ? { ...f, overrides: k === null ? null : { ...(f.overrides ?? {}), sizing: { ...rules.sizing, k } } } : f)));
  return (
    <div className="flex max-w-[600px] flex-col gap-8">
      <section>
        <H>{tr("任务名称", "Task name")}</H>
        <Input value={name} onChange={(e) => setName(e.target.value)} invalid={!name.trim()} placeholder={tr("如：HL 聪明钱 #1", "e.g. HL smart money #1")} />
      </section>
      <section>
        <H hint={tr("不填则继承任务规则。", "Leave empty to inherit the task rules.")}>{tr("按账户覆盖倍数", "Per-account multiple")}</H>
        <div className="flex flex-col">
          {followers.map((f) => {
            const c = conns.find((x) => x.id === f.connection_id);
            return (
              <div key={f.connection_id} className="flex items-center gap-3 border-b border-border py-2.5">
                {c ? <PlatformTag platform={c.platform} testnet={c.testnet} /> : null}
                <span className="flex-1 text-sm">{c?.alias}</span>
                {rules.sizing.mode === "fixed_notional" ? (
                  <span className="text-xs text-muted-fg">{tr("固定名义模式不支持覆盖倍数", "Not available for fixed notional")}</span>
                ) : (
                  <NumInput className="w-28" value={f.overrides?.sizing?.k ?? ""} onChange={(v) => setOverride(f.connection_id, v === "" ? null : v)} placeholder={`× ${rules.sizing.k}`} />
                )}
              </div>
            );
          })}
        </div>
      </section>
      {!editing ? (
        <section>
          <Toggle checked={startNow} onChange={setStartNow} label={tr("创建后立即启动", "Start right after creating")} />
          <p className="mt-2 text-xs text-muted-fg">{rules.start === "sync_existing" ? tr("启动后将立即同步信号源已有持仓。", "Existing source positions will be synced immediately.") : tr("启动后只跟随之后新开的仓位。", "Only positions opened after start are followed.")}</p>
        </section>
      ) : null}
    </div>
  );
}

function PreviewPanel({ loading, data, error, sourceLabel, empty }: { loading: boolean; data?: Awaited<ReturnType<typeof api.preview>>; error: string | null; sourceLabel: string; empty: boolean }) {
  const tr = useTr();
  const base = data?.sample_base;
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-card px-6 py-7 max-lg:w-full max-lg:border-t max-lg:border-l-0 max-md:px-4">
      <div className="flex items-center justify-between">
        <h3 className="text-md font-semibold">{tr("按当前规则预览", "Preview with current rules")}</h3>
        {loading ? <Spinner /> : null}
      </div>
      {empty ? (
        <p className="mt-4 text-xs text-muted-fg">{tr("选择信号源与跟单账户后显示预览。", "Choose a source and followers to see a preview.")}</p>
      ) : error ? (
        <p className="mt-4 text-xs text-danger">{error}</p>
      ) : data ? (
        <>
          <p className="mt-3 text-xs text-muted-fg">
            {tr("信号源", "Source")} {sourceLabel}，{tr("权益", "equity")} {Number(data.source_equity) > 0 ? `${num(data.source_equity, 0)} USDT` : tr("未公开", "hidden")} · {tr(`${data.source_positions} 个持仓`, `${data.source_positions} positions`)}
          </p>
          <table className="mt-5 w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-fg">
                <th className="py-2 text-left font-normal">{tr("账户", "Account")}</th>
                <th className="text-right font-normal">{tr("比例", "Ratio")}</th>
                <th className="text-right font-normal">{base ? tr(`${base} 目标`, `${base} target`) : tr("目标", "Target")}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.connection_id} className="border-b border-border">
                  <td className="py-2.5">{r.alias}</td>
                  <td className="num text-right">{r.ratio_pct != null ? `${num(r.ratio_pct, 2)}%` : "—"}</td>
                  <td className="num text-right">{r.sample_target ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-6 flex flex-col gap-3">
            {data.warnings.map((w) => (
              <div key={w} className="flex gap-2 text-xs">
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
                <span>{w}</span>
              </div>
            ))}
          </div>
          <div className="flex-1" />
          <div className="border-t border-border pt-4 text-xs">
            <div className="flex justify-between py-1">
              <span className="text-muted-fg">{tr("若立即同步，名义仓位合计", "Notional if synced now")}</span>
              <span className="num">{num(data.sync_notional, 0)} USDT</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-muted-fg">{tr("占跟单账户可用保证金", "Of available margin")}</span>
              <span className="num">{num(data.sync_margin_pct, 1)}%</span>
            </div>
          </div>
        </>
      ) : loading ? null : null}
    </aside>
  );
}
