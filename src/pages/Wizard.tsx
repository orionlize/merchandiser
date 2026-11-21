import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, Bell, Check, Eye, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Checkbox, Field, Input, Loading, NumInput, PlatformTag, Radio, Seg, Spinner, Toggle } from "../components/ui";
import { api, errMsg, type FollowerSpec, type Risk, type Rules, type TPSL, type WatchRules } from "../lib/api";
import { num, price, qty, shortAddr } from "../lib/format";
import { useTr } from "../lib/i18n";
import { qc, useConnections, useNotify, usePlazaWallet, useSources, useTask } from "../lib/queries";
import { useUi } from "../lib/store";

const DEFAULT_TPSL: TPSL = { enabled: false, tp_pct: "50", sl_pct: "25", trail_activate_pct: null, trail_callback_pct: null };

const DEFAULT_WATCH: WatchRules = { open: true, add: true, reduce: true, close: true, min_notional: "0" };

const DEFAULT_RULES: Rules = {
  sizing: { mode: "allocated", k: "1", notional: "500", capital: "1000", compound: false },
  leverage: { mode: "follow", value: 5, cap: 10, margin: "cross" },
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
  tpsl: DEFAULT_TPSL,
  mode: "copy",
  watch: DEFAULT_WATCH,
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
  loss_unit: "usdt",
  max_positions: null,
  profit_target: null,
  profit_action: "pause",
  source_dd_pct: null,
  source_dd_action: "pause",
};

const pos = (v: string | null | undefined) => v != null && v !== "" && Number(v) > 0;

/** Problems with the TP / SL settings, or null. */
function tpslError(t: TPSL | undefined, tr: (zh: string, en: string) => string): string | null {
  if (!t?.enabled) return null;
  if (!pos(t.tp_pct) && !pos(t.sl_pct) && !pos(t.trail_activate_pct)) return tr("请至少填写一项止盈或止损", "Set at least one level");
  if (pos(t.sl_pct) && Number(t.sl_pct) > 100) return tr("止损 ROE 应在 0–100% 之间", "Stop loss ROE must be 0–100%");
  if (pos(t.trail_activate_pct) !== pos(t.trail_callback_pct)) return tr("移动止盈需同时填写激活收益率与回撤", "Trailing needs both activation and callback");
  return null;
}

type Step = 0 | 1 | 2 | 3 | 4;

export function Wizard() {
  const tr = useTr();
  const { route, go, toast } = useUi();
  const editId = route.id;
  const { data: existing, isLoading: loadingTask } = useTask(editId);
  const { data: sources } = useSources();
  const { data: conns } = useConnections();
  // Turning a watch task into a copy task (task detail → 转为跟单).
  const converting = !!editId && !!route.convert;
  // Coming from the plaza the source is already chosen.
  const [step, setStep] = useState<Step>(route.src ? 1 : 0);
  const [sourceId, setSourceId] = useState<string>(route.src ?? "");
  const [followers, setFollowers] = useState<FollowerSpec[]>([]);
  // From the plaza simulation: start with the simulated capital.
  const [rules, setRules] = useState<Rules>(() => (route.capital ? { ...DEFAULT_RULES, sizing: { ...DEFAULT_RULES.sizing, capital: route.capital } } : DEFAULT_RULES));
  const [risk, setRisk] = useState<Risk>(DEFAULT_RISK);
  const [name, setName] = useState("");
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (existing && !loaded) {
      setSourceId(existing.source_id);
      setFollowers(existing.followers.map((f) => ({ connection_id: f.connection_id, overrides: f.overrides })));
      const r: Rules = { ...DEFAULT_RULES, ...existing.rules, tpsl: { ...DEFAULT_TPSL, ...existing.rules.tpsl }, watch: { ...DEFAULT_WATCH, ...existing.rules.watch } };
      setRules(converting ? { ...r, mode: "copy" } : r);
      setRisk({ ...DEFAULT_RISK, ...existing.risk });
      setName(existing.name);
      // Converting starts at the follower accounts, which a watch task has none of.
      setStep(converting ? 1 : 2);
      setLoaded(true);
    }
  }, [existing, loaded, converting]);
  const watching = rules.mode === "watch";
  // A copy task stays a copy task; a watch task becomes one only by converting.
  const lockedMode = editId ? (existing?.rules.mode === "watch" && !converting ? "watch" : "copy") : null;

  const source = sources?.find((s) => s.id === sourceId);
  const eligible = (conns ?? []).filter((c) => c.id !== source?.connection_id && (c.platform === "paper" || (c.platform === "hyperliquid" && c.perms?.trade)));

  useEffect(() => {
    if (!editId && source && !name) setName(source.kind === "hl_address" ? `${source.name}` : `${source.name} 跟单`);
  }, [source, editId, name]);

  const kInvalid = rules.sizing.mode !== "fixed_notional" && (!(Number(rules.sizing.k) >= 0.1) || Number(rules.sizing.k) > 10);
  const nInvalid = rules.sizing.mode === "fixed_notional" && !(Number(rules.sizing.notional) > 0);
  const cInvalid = rules.sizing.mode === "allocated" && !(Number(rules.sizing.capital) >= 10);
  const capInvalid = !(rules.leverage.cap >= 1);
  const tpslErr = tpslError(rules.tpsl, tr);
  const pctOver = (v: string | null) => risk.loss_unit === "pct" && v != null && Number(v) > 100;
  const riskOk = Number(risk.max_slippage_pct) > 0 && !pctOver(risk.daily_loss_limit) && !pctOver(risk.total_loss_limit);
  const watchInvalid = watching && !(Number(rules.watch?.min_notional || 0) >= 0);
  const ddPct = risk.source_dd_pct;
  const ddInvalid = ddPct != null && ddPct !== "" && !(Number(ddPct) > 0 && Number(ddPct) < 100);
  const needFollowers = !watching && followers.length === 0;
  const canNext = [
    !!sourceId,
    // Without accounts the task can still be a watch task (chosen on the next step).
    !converting || followers.length > 0,
    watching ? !watchInvalid : !needFollowers && !kInvalid && !nInvalid && !cInvalid && !capInvalid && !tpslErr,
    watching || (riskOk && !ddInvalid),
    !!name.trim(),
  ][step];
  // Watch tasks have no follower accounts and no risk checks: skip those steps.
  const skipped = (i: number) => watching && (i === 1 || i === 3);
  const nextStep = (from: number) => {
    let i = from + 1;
    while (i < 4 && skipped(i)) i++;
    return i as Step;
  };
  const prevStep = (from: number) => {
    let i = from - 1;
    while (i > 0 && skipped(i)) i--;
    return Math.max(i, 0) as Step;
  };

  const previewKey = JSON.stringify({ sourceId, followers, sizing: rules.sizing, bl: rules.blacklist, wl: rules.whitelist, dir: rules.direction, rev: rules.reverse });
  const preview = useQuery({
    queryKey: ["preview", previewKey, editId ?? ""],
    queryFn: () => api.preview({ source_id: sourceId, followers, rules, task_id: editId ?? null }),
    enabled: !watching && !!sourceId && followers.length > 0 && step >= 1 && !kInvalid && !nInvalid && !cInvalid,
    staleTime: 15000,
    retry: 0,
  });

  const steps = [tr("信号源", "Source"), tr("跟单账户", "Followers"), tr("设规则", "Rules"), tr("风控", "Risk"), tr("确认", "Confirm")];
  const nextLabel =
    step < 4
      ? tr(`下一步：${steps[nextStep(step)]}`, `Next: ${steps[nextStep(step)]}`)
      : converting
        ? tr("转为跟单", "Start copying")
        : editId
          ? tr("保存修改", "Save changes")
          : startNow
            ? tr("创建并启动", "Create and start")
            : tr("创建任务", "Create task");

  const submit = async () => {
    setBusy(true);
    try {
      if (editId) {
        await api.updateTask(editId, { name, rules, risk, followers: watching ? [] : followers });
        toast(
          converting
            ? tr("已转为跟单任务，按信号源当前持仓重新开始", "Now a copy task, starting from the source's current positions")
            : tr("规则已更新，任务将按新规则对账", "Rules updated; the task reconciles under the new rules"),
        );
        qc.invalidateQueries({ queryKey: ["task"] });
        go("task", editId);
      } else {
        const id = await api.createTask({ name, source_id: sourceId, followers: watching ? [] : followers, rules, risk, start_now: startNow });
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
      {/* Stepper */}
      <div className="flex h-[52px] shrink-0 items-center gap-4 overflow-x-auto border-b border-border px-4 md:px-6">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center gap-4">
            <button disabled={(i > step && !canNext) || skipped(i)} onClick={() => i <= step && !skipped(i) && setStep(i as Step)} className={clsx("flex items-center gap-2", skipped(i) && "opacity-50")}>
              {skipped(i) ? (
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-dashed border-muted-fg text-[11px] text-muted-fg">{i + 1}</span>
              ) : i < step ? (
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-muted-fg text-muted-fg">
                  <Check size={11} />
                </span>
              ) : (
                <span className={clsx("flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px]", i === step ? "bg-primary font-semibold text-on-primary" : "border border-border text-muted-fg")}>{i + 1}</span>
              )}
              <span className={clsx("text-sm whitespace-nowrap", i === step ? "font-semibold" : "text-muted-fg max-md:hidden")}>{s}</span>
              {skipped(i) ? <span className="text-xs whitespace-nowrap text-muted-fg max-md:hidden">{tr("观察模式跳过", "skipped")}</span> : null}
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
            <FollowerStep eligible={eligible} followers={followers} setFollowers={setFollowers} converting={converting} />
          ) : step === 2 ? (
            <RulesStep
              rules={rules}
              setRules={setRules}
              kInvalid={kInvalid}
              nInvalid={nInvalid}
              cInvalid={cInvalid}
              tpslErr={tpslErr}
              lockedMode={lockedMode}
              needFollowers={needFollowers}
              onPickFollowers={() => setStep(1)}
              onConvert={editId ? () => useUi.getState().goTo({ page: "wizard", id: editId, convert: true }) : undefined}
            />
          ) : step === 3 ? (
            <RiskStep risk={risk} setRisk={setRisk} rules={rules} setRules={setRules} capital={preview.data?.rows.reduce((a, r) => a + Number(r.capital ?? 0), 0) || null} sourceAddress={source?.kind === "hl_address" ? source.address : null} ddInvalid={ddInvalid} />
          ) : (
            <ConfirmStep name={name} setName={setName} startNow={startNow} setStartNow={setStartNow} editing={!!editId} converting={converting} followers={watching ? [] : followers} setFollowers={setFollowers} rules={rules} conns={conns ?? []} />
          )}
        </div>
        {watching ? (
          <WatchPreview sourceId={sourceId} rules={rules} name={name} sourceLabel={source ? (source.kind === "hl_address" ? `HL ${shortAddr(source.address)}` : source.name) : ""} />
        ) : (
          <PreviewPanel loading={preview.isFetching} data={preview.data} error={preview.error ? errMsg(preview.error) : null} sourceLabel={source ? (source.kind === "hl_address" ? `HL ${shortAddr(source.address)}` : source.name) : ""} empty={!sourceId || followers.length === 0} />
        )}
      </div>
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-t border-border px-4 md:px-6">
        <Button variant="ghost" onClick={() => (editId ? go("task", editId) : go("tasks"))}>
          {tr("取消", "Cancel")}
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-fg max-md:hidden">
            {!canNext
              ? tr("请完成必填项", "Complete required fields")
              : watching && step >= 2
                ? tr("观察模式：不下单", "Watch only: no orders")
                : [tr("已选信号源", "Source selected"), followers.length ? tr(`已选 ${followers.length} 个账户`, `${followers.length} selected`) : tr("未选账户：只能建观察任务", "No account: watch-only task"), tr("规则已填完", "Rules complete"), tr("风控已填完", "Risk complete"), tr("可以创建", "Ready")][step]}
          </span>
          <Button disabled={step === 0 || (converting && step === 1)} onClick={() => setStep((s) => prevStep(s))}>
            {tr("上一步", "Back")}
          </Button>
          <Button variant="primary" disabled={!canNext} loading={busy} onClick={() => (step < 4 ? setStep((s) => nextStep(s)) : submit())}>
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
  const { data: all } = useSources();
  // Sources left over from removed venues cannot be followed.
  const sources = all?.filter((s) => (s.kind === "hl_address" || s.kind === "api") && (s.platform === "hyperliquid" || s.platform === "paper"));
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
                <div className="num mt-0.5 truncate text-xs text-muted-fg">{s.kind === "hl_address" ? s.address : s.platform === "paper" ? `${tr("模拟账户", "Paper account")} · ${s.connection_alias}` : `${tr("只读 API", "Read-only API")} · ${s.connection_alias}`}</div>
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

function FollowerStep({ eligible, followers, setFollowers, converting }: { eligible: ReturnType<typeof useConnections>["data"]; followers: FollowerSpec[]; setFollowers: (f: FollowerSpec[]) => void; converting: boolean }) {
  const tr = useTr();
  const { go } = useUi();
  const sel = new Set(followers.map((f) => f.connection_id));
  return (
    <div className="max-w-[640px]">
      {converting ? (
        <p className="mb-4 rounded-md bg-primary-soft px-3 py-2 text-xs">
          {tr("转为跟单：选好账户和仓位规则后，任务按当时的信号源持仓重新开始（启动时的处理方式在「设规则」里选）。观察期间的信号记录会保留。", "Turning into a copy task: once accounts and sizing are set, the task restarts from the source's positions at that moment (choose how on the Rules step). Signals seen while watching are kept.")}
        </p>
      ) : null}
      <H
        hint={
          converting
            ? tr("只列出具备合约交易权限的连接与模拟账户。跟单账户须为单向持仓。", "Only trade-enabled connections and paper accounts are listed. Followers must use one-way mode.")
            : tr("只列出具备合约交易权限的连接与模拟账户。跟单账户须为单向持仓。不选账户也可以继续，在下一步建「只观察提醒」任务。", "Only trade-enabled connections and paper accounts are listed. Followers must use one-way mode. You can go on without one and make a watch-only task on the next step.")
        }
      >
        {tr("选择跟单账户", "Choose follower accounts")}
      </H>
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

function NewTag() {
  const tr = useTr();
  return <span className="ml-1.5 rounded-sm bg-primary-soft px-1.5 py-px align-middle text-[11px] font-semibold text-primary">{tr("新", "New")}</span>;
}

function RulesStep({
  rules,
  setRules,
  kInvalid,
  nInvalid,
  cInvalid,
  tpslErr,
  lockedMode,
  needFollowers,
  onPickFollowers,
  onConvert,
}: {
  rules: Rules;
  setRules: (r: Rules) => void;
  kInvalid: boolean;
  nInvalid: boolean;
  cInvalid: boolean;
  tpslErr: string | null;
  lockedMode: "copy" | "watch" | null;
  needFollowers: boolean;
  onPickFollowers: () => void;
  onConvert?: () => void;
}) {
  const tr = useTr();
  const set = (p: Partial<Rules>) => setRules({ ...rules, ...p });
  const tpsl = rules.tpsl ?? DEFAULT_TPSL;
  const setTpsl = (p: Partial<TPSL>) => set({ tpsl: { ...tpsl, ...p } });
  const opt = (v: string) => (v.trim() === "" ? null : v);
  const modes = [
    { v: "allocated" as const, t: tr("投入本金", "Allocated capital"), d: tr("本金 ÷ 信号源权益 × 倍数", "Capital ÷ source equity × k"), isNew: true },
    { v: "equity_ratio" as const, t: tr("按权益比例", "Equity ratio"), d: tr("账户全部权益 ÷ 信号源权益 × 倍数", "Account equity ÷ source equity × k") },
    { v: "fixed_multiple" as const, t: tr("固定倍数", "Fixed multiple"), d: tr("信号源数量 × k", "Source qty × k") },
    { v: "fixed_notional" as const, t: tr("固定名义金额", "Fixed notional"), d: tr("每次开仓固定 USDT", "Fixed USDT per open") },
  ];
  const kField = (
    <Field label={rules.sizing.mode === "equity_ratio" ? tr("权益倍数", "Equity multiple") : tr("倍数 k", "Multiple k")} error={kInvalid ? tr("请填写倍数，范围 0.1–10。", "Enter a multiple between 0.1 and 10.") : null}>
      <NumInput value={rules.sizing.k} onChange={(v) => set({ sizing: { ...rules.sizing, k: v } })} invalid={kInvalid} />
    </Field>
  );
  // ROE ÷ leverage = price move; illustrate at the leverage cap.
  const lev = Math.max(rules.leverage.mode === "fixed" ? Math.min(rules.leverage.value, rules.leverage.cap) : rules.leverage.cap, 1);
  const move = (roe: string | null) => (pos(roe) ? `${num(Number(roe) / lev, 2)}%` : null);
  const watching = rules.mode === "watch";
  const typeSection = <TaskTypeSection rules={rules} setRules={setRules} lockedMode={lockedMode} needFollowers={needFollowers} onPickFollowers={onPickFollowers} onConvert={onConvert} />;
  if (watching)
    return (
      <div className="flex max-w-[640px] flex-col gap-8">
        {typeSection}
        <WatchSection rules={rules} setRules={setRules} />
        <section>
          <H>{rules.whitelist.length ? tr("品种白名单", "Coin allow-list") : tr("品种黑名单", "Coin block-list")}</H>
          <BlacklistEditor rules={rules} set={set} />
        </section>
      </div>
    );
  return (
    <div className="flex max-w-[640px] flex-col gap-8">
      {typeSection}
      <section>
        <H>{tr("仓位计算", "Position sizing")}</H>
        <p className="mb-3 rounded-md bg-primary-soft px-3 py-2 text-xs">{tr("多个任务共用一个账户时，建议用「投入本金」：每个任务只按自己的本金下单，互不挤占。", "When several tasks share an account, use allocated capital: each task sizes against its own capital.")}</p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {modes.map((m) => (
            <button
              key={m.v}
              onClick={() => set({ sizing: { ...rules.sizing, mode: m.v } })}
              className={clsx("rounded-md border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-40", rules.sizing.mode === m.v ? "border-fg bg-muted" : "border-border hover:bg-muted/50")}
            >
              <div className="text-sm font-semibold">
                {m.t}
                {m.isNew ? <NewTag /> : null}
              </div>
              <div className="mt-0.5 text-xs text-muted-fg">{m.d}</div>
            </button>
          ))}
        </div>
        {rules.sizing.mode === "allocated" ? (
          <>
            <div className="mt-4 flex flex-wrap items-end gap-4">
              <Field label={tr("每个账户投入本金", "Capital per account")} error={cInvalid ? tr("本金至少 10 USDT", "At least 10 USDT") : null}>
                <NumInput className="w-40" value={rules.sizing.capital ?? ""} onChange={(v) => set({ sizing: { ...rules.sizing, capital: v } })} suffix="USDT" invalid={cInvalid} />
              </Field>
              <div className="w-28">{kField}</div>
              <div className="pb-2">
                <Toggle checked={!!rules.sizing.compound} onChange={(v) => set({ sizing: { ...rules.sizing, compound: v } })} label={tr("复利：已实现盈亏计入本金", "Compound realised PnL")} />
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-fg">
              {tr("目标仓位 = 信号源仓位 × 本金 ÷ 信号源权益 × k。开启复利时，本金随本任务在该账户的已实现盈亏增减。本金可在确认页按账户单独覆盖。", "Target = source position × capital ÷ source equity × k. With compounding, the capital moves with the task's realised PnL on the account. Override per account on the confirm step.")}
            </p>
          </>
        ) : (
          <>
            <div className="mt-4 w-40">
              {rules.sizing.mode === "fixed_notional" ? (
                <Field label={tr("每次开仓金额", "Per open")} error={nInvalid ? tr("请填写大于 0 的金额", "Enter an amount above 0") : null}>
                  <NumInput value={rules.sizing.notional} onChange={(v) => set({ sizing: { ...rules.sizing, notional: v } })} suffix="USDT" invalid={nInvalid} />
                </Field>
              ) : (
                kField
              )}
            </div>
            <p className="mt-2 text-xs text-muted-fg">{tr("每个跟单账户可在确认页单独覆盖。", "Each follower can override this on the confirm step.")}</p>
          </>
        )}
      </section>

      <section>
        <H>{tr("杠杆与保证金", "Leverage and margin")}</H>
        <div className="flex flex-wrap items-center gap-3">
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
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-sm">
            {tr("保证金模式", "Margin mode")}
            <NewTag />
          </span>
          <Seg
            value={rules.leverage.margin ?? "cross"}
            onChange={(v) => set({ leverage: { ...rules.leverage, margin: v } })}
            options={[
              { value: "cross", label: tr("全仓", "Cross") },
              { value: "isolated", label: tr("逐仓", "Isolated") },
            ]}
          />
        </div>
        <p className="mt-2 text-xs text-muted-fg">
          {rules.leverage.margin === "isolated"
            ? tr("逐仓：每个币种单独占用保证金，单币爆仓不会拖累账户其他仓位。已有持仓的币种无法切换模式，会按账户当前设置下单。", "Isolated: each coin has its own margin, so one liquidation cannot drag the rest. A coin with an open position keeps its current mode.")
            : tr("全仓：账户全部可用余额共同作为保证金。", "Cross: the whole account balance backs every position.")}
        </p>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-md font-semibold">
            {tr("单仓止盈止损", "Per-position TP / SL")}
            <NewTag />
          </h3>
          <Toggle checked={tpsl.enabled} onChange={(v) => setTpsl({ enabled: v })} label={tpsl.enabled ? tr("已开启", "On") : tr("关闭", "Off")} />
        </div>
        <p className="text-xs text-muted-fg">
          {tr("按本任务在该币种的持仓均价与杠杆计算收益率（ROE）。触发后市价平掉本任务的份额，该币种暂停跟随，等信号源平仓或反手后再重新跟。", "ROE uses the task's own average entry and leverage. When hit, the task's share is closed at market and the coin is left alone until the source closes or flips it.")}
        </p>
        {tpsl.enabled ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <Field label={tr("止盈 ROE", "Take profit ROE")} hint={move(tpsl.tp_pct) ? tr(`约价格 +${move(tpsl.tp_pct)}（${lev}x）`, `≈ price +${move(tpsl.tp_pct)} at ${lev}x`) : tr("留空不止盈", "Empty = off")}>
                <NumInput value={tpsl.tp_pct ?? ""} onChange={(v) => setTpsl({ tp_pct: opt(v) })} prefix="+" suffix="%" placeholder={tr("不设", "Off")} />
              </Field>
              <Field label={tr("止损 ROE", "Stop loss ROE")} hint={move(tpsl.sl_pct) ? tr(`约价格 −${move(tpsl.sl_pct)}（${lev}x）`, `≈ price −${move(tpsl.sl_pct)} at ${lev}x`) : tr("留空不止损", "Empty = off")}>
                <NumInput value={tpsl.sl_pct ?? ""} onChange={(v) => setTpsl({ sl_pct: opt(v) })} prefix="−" suffix="%" placeholder={tr("不设", "Off")} />
              </Field>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              <span>{tr("移动止盈：ROE 达到", "Trailing: once ROE reaches")}</span>
              <NumInput className="w-24" value={tpsl.trail_activate_pct ?? ""} onChange={(v) => setTpsl({ trail_activate_pct: opt(v) })} prefix="+" suffix="%" placeholder={tr("不设", "Off")} />
              <span>{tr("后，从最高点回撤", ", close after falling")}</span>
              <NumInput className="w-20" value={tpsl.trail_callback_pct ?? ""} onChange={(v) => setTpsl({ trail_callback_pct: opt(v) })} suffix="%" />
              <span>{tr("即平仓", "from the peak")}</span>
            </div>
            <p className="mt-2 text-xs text-muted-fg">{tr("回撤按 ROE 百分点计算，例如峰值 +40% 回撤 10% 即在 +30% 平仓。", "The callback is in ROE points: a +40% peak with a 10% callback closes at +30%.")}</p>
            {tpslErr ? <p className="mt-2 text-xs text-danger">{tpslErr}</p> : null}
          </>
        ) : null}
      </section>

      <section>
        <H>{tr("挂单镜像", "Order mirroring")}</H>
        <Toggle checked={rules.mirror.enabled} onChange={(v) => set({ mirror: { ...rules.mirror, enabled: v } })} label={tr("同步限价单与止盈止损", "Mirror limit and TP/SL orders")} />
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
          <BlacklistEditor rules={rules} set={set} />
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


function BlacklistEditor({ rules, set }: { rules: Rules; set: (p: Partial<Rules>) => void }) {
  const tr = useTr();
  const [newSym, setNewSym] = useState("");
  const [adding, setAdding] = useState(false);
  return (
    <>
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
    </>
  );
}

function TaskTypeSection({ rules, setRules, lockedMode, needFollowers, onPickFollowers, onConvert }: { rules: Rules; setRules: (r: Rules) => void; lockedMode: "copy" | "watch" | null; needFollowers: boolean; onPickFollowers: () => void; onConvert?: () => void }) {
  const tr = useTr();
  const watching = rules.mode === "watch";
  const types = [
    { v: "copy" as const, icon: Check, t: tr("跟单下单", "Copy trades"), d: tr("按仓位规则在跟单账户自动下单，带风控与对账。", "Places orders on your accounts by the sizing rules, with risk checks and reconciliation.") },
    { v: "watch" as const, icon: Eye, t: tr("只观察提醒", "Watch only"), d: tr("不下单、不占本金。信号源开平仓时推送给你，自己决定跟不跟。", "No orders, no capital. You get a push when the source opens or closes and decide yourself.") },
  ];
  return (
    <section>
      <H>
        {tr("任务类型", "Task type")}
        <NewTag />
      </H>
      <div className="grid grid-cols-2 gap-2">
        {types.map((m) => {
          // Editing: a copy task cannot become a watch task; a watch task turns into one by converting.
          const disabled = lockedMode != null && lockedMode !== m.v && !(lockedMode === "watch" && m.v === "copy" && onConvert);
          return (
            <button
              key={m.v}
              disabled={disabled}
              onClick={() => {
                if (lockedMode === "watch" && m.v === "copy") onConvert?.();
                else setRules({ ...rules, mode: m.v });
              }}
              className={clsx(
                "flex gap-3 rounded-md border px-3 py-3 text-left transition-[border-color,background-color] duration-150 disabled:cursor-not-allowed disabled:opacity-40",
                (rules.mode ?? "copy") === m.v ? "border-primary bg-primary-soft" : "border-border hover:bg-muted/50",
              )}
            >
              <m.icon size={16} className={clsx("mt-0.5 shrink-0", (rules.mode ?? "copy") === m.v ? "text-primary" : "text-muted-fg")} />
              <span>
                <span className="block text-sm font-semibold">{m.t}</span>
                <span className="mt-0.5 block text-xs text-muted-fg">{m.d}</span>
              </span>
            </button>
          );
        })}
      </div>
      {watching ? (
        <p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-fg">
          {lockedMode === "watch"
            ? tr("观察任务不下单。点「跟单下单」转为跟单任务：选好跟单账户后按当时的信号源持仓开始跟。", "A watch task places no orders. Pick Copy trades to turn it into a copy task, starting from the source's positions at that moment.")
            : tr("观察模式不需要跟单账户；仓位计算、杠杆、止盈止损都不生效。之后可在任务详情里「转为跟单」，按当时的信号源持仓开始跟。", "Watch mode needs no accounts; sizing, leverage and TP / SL do not apply. Later, Convert to copy on the task page starts copying from the source's positions at that moment.")}
        </p>
      ) : lockedMode === "copy" && !onConvert ? null : needFollowers ? (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle size={13} />
          {tr("跟单下单需要至少一个跟单账户。", "Copying needs at least one follower account.")}
          <Button variant="link" className="text-xs" onClick={onPickFollowers}>
            {tr("返回选择", "Choose accounts")}
          </Button>
        </p>
      ) : null}
    </section>
  );
}

function WatchSection({ rules, setRules }: { rules: Rules; setRules: (r: Rules) => void }) {
  const tr = useTr();
  const { data: notify } = useNotify();
  const w = { ...DEFAULT_WATCH, ...rules.watch };
  const setW = (p: Partial<WatchRules>) => setRules({ ...rules, watch: { ...w, ...p } });
  const kinds: { k: "open" | "add" | "reduce" | "close"; zh: string; en: string }[] = [
    { k: "open", zh: "开仓", en: "Opens" },
    { k: "add", zh: "加仓", en: "Adds" },
    { k: "reduce", zh: "减仓", en: "Reductions" },
    { k: "close", zh: "平仓与反手", en: "Closes and flips" },
  ];
  const cfg = notify?.config;
  const channels = [cfg?.telegram.enabled ? "Telegram" : null, cfg?.webhook.enabled ? webhookLabel(cfg.webhook.format, tr) : null].filter(Boolean) as string[];
  const signalOff = cfg && cfg.events.signal === false;
  const minBad = !(Number(w.min_notional || 0) >= 0);
  return (
    <>
      <section>
        <H hint={tr("按信号源净持仓的变化判断，同一秒内的多笔成交合并成一条。", "Judged from changes in the source's net position; fills within the same read become one signal.")}>{tr("推送哪些信号", "Signals to push")}</H>
        <div className="flex flex-wrap gap-2">
          {kinds.map((c) => (
            <button
              key={c.k}
              onClick={() => setW({ [c.k]: !w[c.k] })}
              aria-pressed={w[c.k]}
              className={clsx("inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors duration-150", w[c.k] ? "border-primary bg-primary-soft text-fg" : "border-border text-muted-fg hover:bg-muted/50")}
            >
              {w[c.k] ? <Check size={13} className="text-primary" /> : null}
              {tr(c.zh, c.en)}
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-sm">{tr("加减仓名义金额至少", "Adds and reductions of at least")}</span>
          <NumInput className="w-36" value={w.min_notional === "0" ? "" : w.min_notional} onChange={(v) => setW({ min_notional: v.trim() === "" ? "0" : v })} suffix="USDT" placeholder={tr("不限", "Any")} invalid={minBad} />
        </div>
        <p className="mt-2 text-xs text-muted-fg">{tr("小于这个金额的加减仓不推送；开仓、平仓和反手始终推送。", "Smaller adds and reductions are not pushed; opens, closes and flips always are.")}</p>
        {!kinds.some((c) => w[c.k]) ? <p className="mt-2 text-xs text-warning">{tr("没有勾选任何信号，任务只在详情页的信号列表里记录。", "Nothing selected: signals are only listed on the task page.")}</p> : null}
      </section>
      <section>
        <H hint={tr("用「设置 · 通知与心跳」里开启的渠道；没开任何渠道时只在任务详情的信号列表里记录。", "Uses the channels enabled under Settings · Notifications; with none, signals are only listed on the task page.")}>{tr("推送渠道", "Channels")}</H>
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-sm">
          <Bell size={14} className={channels.length ? "text-success" : "text-muted-fg"} />
          <span className="flex-1">{channels.length ? tr(`${channels.join("、")} 已开启`, `${channels.join(", ")} on`) : tr("还没有开启推送渠道", "No channel is on")}</span>
          <Button variant="link" className="text-xs" onClick={() => useUi.getState().go("settings")}>
            {tr("去设置", "Settings")}
          </Button>
        </div>
        {signalOff ? <p className="mt-2 text-xs text-warning">{tr("「观察任务的信号」推送在设置里被关掉了，开启后才会推送。", "Watch-task signals are switched off in Settings; turn them on to get pushes.")}</p> : null}
      </section>
    </>
  );
}

function webhookLabel(f: string, tr: (zh: string, en: string) => string) {
  const m: Record<string, [string, string]> = { feishu: ["飞书", "Feishu"], dingtalk: ["钉钉", "DingTalk"], wecom: ["企业微信", "WeCom"], discord: ["Discord", "Discord"], slack: ["Slack", "Slack"], generic: ["Webhook", "Webhook"] };
  const l = m[f] ?? m.generic;
  return tr(l[0], l[1]);
}

/** Watch mode: what the pushes will look like, from the source's open positions. */
function WatchPreview({ sourceId, rules, name, sourceLabel }: { sourceId: string; rules: Rules; name: string; sourceLabel: string }) {
  const tr = useTr();
  const detail = useQuery({ queryKey: ["source-detail", sourceId], queryFn: () => api.sourceDetail(sourceId), enabled: !!sourceId, staleTime: 30_000, retry: 0 });
  const w = { ...DEFAULT_WATCH, ...rules.watch };
  const min = Number(w.min_notional || 0);
  const d = detail.data;
  const ps = (d?.positions ?? [])
    .filter((p) => Number(p.size) !== 0)
    .map((p) => ({ ...p, notional: Math.abs(Number(p.size)) * Number(p.mark_px) }))
    .sort((a, b) => b.notional - a.notional);
  const eq = Number(d?.equity ?? 0);
  const samples: { kind: string; title: string; detail: string }[] = [];
  const top = ps[0];
  const label = name.trim() || tr("观察任务", "Watch task");
  if (top && w.open) {
    const long = Number(top.size) > 0;
    samples.push({
      kind: tr("信号 · 开仓", "Signal · open"),
      title: tr(`${label}：${top.base} ${long ? "开多" : "开空"}`, `${label}: ${top.base} ${long ? "open long" : "open short"}`),
      detail: tr(`0 → ${qty(top.size)}，约 ${num(top.notional, 0)} USDT @ ${price(top.mark_px)}`, `0 → ${qty(top.size)}, ≈ ${num(top.notional, 0)} USDT @ ${price(top.mark_px)}`) + (eq > 0 ? tr(`，占信号源权益 ${num((top.notional / eq) * 100, 1)}%`, `, ${num((top.notional / eq) * 100, 1)}% of equity`) : ""),
    });
  }
  const second = ps[1] ?? ps[0];
  if (second && w.reduce) {
    const sz = Number(second.size);
    const after = sz * 0.6;
    const n = Math.abs(sz - after) * Number(second.mark_px);
    if (n >= min)
      samples.push({
        kind: tr("信号 · 减仓", "Signal · reduce"),
        title: tr(`${label}：${second.base} 减仓`, `${label}: ${second.base} reduce`),
        detail: tr(`${qty(second.size)} → ${qty(after)}，约 ${num(n, 0)} USDT @ ${price(second.mark_px)}`, `${qty(second.size)} → ${qty(after)}, ≈ ${num(n, 0)} USDT @ ${price(second.mark_px)}`),
      });
  }
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-card px-6 py-7 max-lg:w-full max-lg:border-t max-lg:border-l-0 max-md:px-4">
      <div className="flex items-center justify-between">
        <h3 className="text-md font-semibold">{tr("信号推送预览", "Push preview")}</h3>
        {detail.isFetching ? <Spinner /> : null}
      </div>
      {!sourceId ? (
        <p className="mt-4 text-xs text-muted-fg">{tr("选择信号源后显示预览。", "Choose a source to see a preview.")}</p>
      ) : detail.error ? (
        <p className="mt-4 text-xs text-danger">{errMsg(detail.error)}</p>
      ) : d ? (
        <>
          <p className="mt-3 text-xs text-muted-fg">
            {tr("信号源", "Source")} {sourceLabel}，{tr("权益", "equity")} {eq > 0 ? `${num(eq, 0)} USDT` : tr("未公开", "hidden")} · {tr(`${ps.length} 个持仓`, `${ps.length} positions`)}
          </p>
          <div className="mt-5 flex flex-col gap-3">
            {samples.length ? (
              samples.map((x) => (
                <div key={x.kind} className="rounded-md border border-border bg-bg px-3 py-2.5">
                  <div className="text-xs text-primary">{x.kind}</div>
                  <div className="mt-1 text-sm font-semibold">{x.title}</div>
                  <div className="num mt-0.5 text-xs text-muted-fg">{x.detail}</div>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-fg">{ps.length ? tr("按当前勾选的信号，这些持仓的变化不会推送。", "With the current filters, changes to these positions would not be pushed.") : tr("信号源当前没有持仓；开仓时会推送。", "The source holds nothing now; you will get a push when it opens.")}</p>
            )}
          </div>
          <p className="mt-3 text-xs text-muted-fg">{tr("示例按信号源当前最大的持仓生成，实际内容以信号为准。", "Examples use the source's largest positions; real pushes follow the actual signals.")}</p>
          <div className="flex-1" />
          <div className="mt-6 border-t border-border pt-4 text-xs">
            <div className="flex justify-between py-1">
              <span className="text-muted-fg">{tr("跟单账户", "Follower accounts")}</span>
              <span>{tr("不需要", "None needed")}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-muted-fg">{tr("占用本金", "Capital used")}</span>
              <span className="num">0</span>
            </div>
          </div>
        </>
      ) : null}
    </aside>
  );
}

function RiskStep({ risk, setRisk, rules, setRules, capital, sourceAddress, ddInvalid }: { risk: Risk; setRisk: (r: Risk) => void; rules: Rules; setRules: (r: Rules) => void; capital: number | null; sourceAddress: string | null; ddInvalid: boolean }) {
  const tr = useTr();
  const set = (p: Partial<Risk>) => setRisk({ ...risk, ...p });
  const opt = (v: string) => (v.trim() === "" ? null : v);
  const pct = risk.loss_unit === "pct";
  const unit = pct ? "%" : "USDT";
  // Percent limits are measured against the allocated capital (or the
  // accounts' equity at start for other sizing modes).
  const allocated = rules.sizing.mode === "allocated";
  const base = allocated ? capital : null;
  const usd = (v: string | null) => (v == null || !pos(v) ? null : pct ? (base ? (base * Number(v)) / 100 : null) : Number(v));
  const daily = usd(risk.daily_loss_limit);
  const total = usd(risk.total_loss_limit);
  const tpsl = rules.tpsl;
  const lines: { label: string; value: string; tone?: "success" | "danger" }[] = [];
  const ddOn = risk.source_dd_pct != null;
  if (ddOn && pos(risk.source_dd_pct)) lines.push({ label: tr(`信号源回撤熔断 · ${risk.source_dd_action === "close" ? "平仓并暂停" : "暂停"}`, `Source drawdown breaker · ${risk.source_dd_action === "close" ? "close and pause" : "pause"}`), value: `−${num(risk.source_dd_pct, 1)}%`, tone: "danger" });
  if (pos(risk.profit_target)) lines.push({ label: tr(`盈利目标 · ${risk.profit_action === "close" ? "平仓并暂停" : "暂停任务"}`, `Profit target · ${risk.profit_action === "close" ? "close and pause" : "pause"}`), value: `+${num(risk.profit_target, 2)}`, tone: "success" });
  if (daily != null) lines.push({ label: tr("日亏损上限（每日重置）", "Daily loss limit (resets daily)"), value: `−${num(daily, 2)}`, tone: "danger" });
  else if (pct && pos(risk.daily_loss_limit)) lines.push({ label: tr("日亏损上限", "Daily loss limit"), value: `−${risk.daily_loss_limit}%`, tone: "danger" });
  if (total != null) lines.push({ label: tr("累计亏损上限", "Total loss limit"), value: `−${num(total, 2)}`, tone: "danger" });
  else if (pct && pos(risk.total_loss_limit)) lines.push({ label: tr("累计亏损上限", "Total loss limit"), value: `−${risk.total_loss_limit}%`, tone: "danger" });
  if (tpsl?.enabled) {
    const tp = pos(tpsl.tp_pct) ? `+${tpsl.tp_pct}%` : "—";
    const sl = pos(tpsl.sl_pct) ? `−${tpsl.sl_pct}%` : "—";
    lines.push({ label: tr("单仓止盈 / 止损（ROE）", "Per-position TP / SL (ROE)"), value: `${tp} / ${sl}` });
    if (pos(tpsl.trail_activate_pct)) lines.push({ label: tr("移动止盈", "Trailing take profit"), value: tr(`+${tpsl.trail_activate_pct}% 后回撤 ${tpsl.trail_callback_pct}%`, `+${tpsl.trail_activate_pct}%, ${tpsl.trail_callback_pct}% back`) });
  }
  if (risk.max_positions) lines.push({ label: tr("最多同时持有币种", "Max coins held"), value: String(risk.max_positions) });
  return (
    <div className="flex max-w-[640px] flex-col gap-8">
      <section>
        <H hint={tr("超出上限的部分跳过并记日志；留空表示不限。", "Anything beyond a cap is skipped and logged. Leave empty for no cap.")}>{tr("仓位上限", "Position caps")}</H>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field label={tr("单品种最大名义仓位", "Max notional per coin")}>
            <NumInput value={risk.max_symbol_notional ?? ""} onChange={(v) => set({ max_symbol_notional: opt(v) })} suffix="USDT" placeholder={tr("不限", "None")} />
          </Field>
          <Field label={tr("账户总名义仓位上限", "Max total notional per account")}>
            <NumInput value={risk.max_total_notional ?? ""} onChange={(v) => set({ max_total_notional: opt(v) })} suffix="USDT" placeholder={tr("不限", "None")} />
          </Field>
          <Field
            label={
              <>
                {tr("最多同时持有币种", "Max coins held at once")}
                <NewTag />
              </>
            }
          >
            <NumInput value={risk.max_positions ? String(risk.max_positions) : ""} onChange={(v) => set({ max_positions: v === "" ? null : Math.floor(Number(v)) || null })} suffix={tr("个", "coins")} placeholder={tr("不限", "None")} />
          </Field>
        </div>
        {risk.max_positions ? <p className="mt-2 text-xs text-muted-fg">{tr(`已持有 ${risk.max_positions} 个币种时，信号源再开新币种不跟；已持有币种的加减仓照常跟。`, `With ${risk.max_positions} coins held, new coins are skipped; adds and trims on held coins still follow.`)}</p> : null}
      </section>
      <section>
        <H hint={tr("本任务累计盈亏（已实现 + 浮动）达到目标后锁定收益，推送通知；需手动恢复。", "Once the task's PnL (realised + unrealised) reaches the target, lock it in and notify; resume manually.")}>
          {tr("盈利目标", "Profit target")}
          <NewTag />
        </H>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">{tr("累计盈利达到", "When PnL reaches")}</span>
          <NumInput className="w-36" value={risk.profit_target ?? ""} onChange={(v) => set({ profit_target: opt(v) })} prefix="+" suffix="USDT" placeholder={tr("不设", "Off")} />
          <Seg
            value={risk.profit_action ?? "pause"}
            onChange={(v) => set({ profit_action: v })}
            options={[
              { value: "pause", label: tr("暂停，保留仓位", "Pause, keep positions") },
              { value: "close", label: tr("平仓并暂停", "Close and pause") },
            ]}
          />
        </div>
        {pos(risk.profit_target) && allocated && capital ? <p className="mt-2 text-xs text-muted-fg">{tr(`按投入本金 ${num(capital, 0)} USDT 计，约为本金收益率 +${num((Number(risk.profit_target) / capital) * 100, 1)}%。`, `≈ +${num((Number(risk.profit_target) / capital) * 100, 1)}% on ${num(capital, 0)} USDT capital.`)}</p> : null}
      </section>
      <SourceDDSection risk={risk} set={set} address={sourceAddress} invalid={ddInvalid} />
      <section>
        <H hint={tr("下单前比对信号源价格与目标平台盘口，偏离超限则本次不跟（减仓与平仓不受限）。", "Compares the source price with the follower's book before opening; skip when beyond. Reductions are never blocked.")}>{tr("单笔最大滑点", "Max slippage per order")}</H>
        <NumInput className="w-32" value={risk.max_slippage_pct} onChange={(v) => set({ max_slippage_pct: v })} suffix="%" invalid={!(Number(risk.max_slippage_pct) > 0)} />
      </section>
      <section>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-md font-semibold">{tr("亏损上限", "Loss limits")}</h3>
            <p className="mt-1 text-xs text-muted-fg">{tr("触发后暂停任务并推送通知，需手动恢复。", "When hit, the task pauses and notifies you; resume manually.")}</p>
          </div>
          <Seg
            size="sm"
            value={risk.loss_unit ?? "usdt"}
            onChange={(v) => set({ loss_unit: v })}
            options={[
              { value: "usdt", label: "USDT" },
              { value: "pct", label: tr("本金 %", "% of capital") },
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label={tr("日亏损上限", "Daily loss limit")} error={pct && Number(risk.daily_loss_limit) > 100 ? tr("应在 0–100% 之间", "0–100%") : null}>
            <NumInput value={risk.daily_loss_limit ?? ""} onChange={(v) => set({ daily_loss_limit: opt(v) })} suffix={unit} placeholder={tr("不限", "None")} />
          </Field>
          <Field label={tr("任务累计亏损上限", "Total loss limit")} error={pct && Number(risk.total_loss_limit) > 100 ? tr("应在 0–100% 之间", "0–100%") : null}>
            <NumInput value={risk.total_loss_limit ?? ""} onChange={(v) => set({ total_loss_limit: opt(v) })} suffix={unit} placeholder={tr("不限", "None")} />
          </Field>
        </div>
        {pct ? (
          <p className="mt-2 text-xs text-muted-fg">
            {allocated && capital
              ? tr(`按投入本金 ${num(capital, 0)} USDT 折算：日亏损 ${daily != null ? num(daily, 0) : "—"} USDT，累计亏损 ${total != null ? num(total, 0) : "—"} USDT。`, `On ${num(capital, 0)} USDT capital: daily ${daily != null ? num(daily, 0) : "—"} USDT, total ${total != null ? num(total, 0) : "—"} USDT.`)
              : tr("按投入本金折算；其他仓位计算方式按任务启动时各账户的权益折算。", "Measured against the allocated capital; other sizing modes use the accounts' equity at start.")}
          </p>
        ) : null}
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
      {lines.length ? (
        <section className="rounded-lg border border-border bg-card px-4 py-3">
          <h3 className="text-sm font-semibold">{tr("触发线一览", "Triggers at a glance")}</h3>
          <p className="mt-1 text-xs text-muted-fg">{tr("按优先级从上到下检查，任一触发即执行。", "Checked top to bottom; the first one hit acts.")}</p>
          <div className="mt-2 flex flex-col">
            {lines.map((l) => (
              <div key={l.label} className="flex items-center justify-between border-b border-border py-2 text-sm last:border-b-0">
                <span className="text-muted-fg">{l.label}</span>
                <span className={clsx("num", l.tone === "success" && "text-success", l.tone === "danger" && "text-danger")}>{l.value}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SourceDDSection({ risk, set, address, invalid }: { risk: Risk; set: (p: Partial<Risk>) => void; address: string | null; invalid: boolean }) {
  const tr = useTr();
  const on = risk.source_dd_pct != null;
  // The trader's own recent drawdown, to put the threshold in context.
  const { data: w } = usePlazaWallet(on ? address : null);
  const hist = w?.max_dd["30d"];
  const limit = Number(risk.source_dd_pct);
  const scale = Math.max(limit, (hist ?? 0) * 100, 1) * 1.25;
  return (
    <section>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-md font-semibold">
            {tr("信号源回撤熔断", "Source drawdown breaker")}
            <NewTag />
          </h3>
          <p className="mt-1 text-xs text-muted-fg">{tr("交易员自己亏损过大时停止跟单，在你的亏损上限触发之前先熔断。按信号源的累计盈亏计算，充值和提现不会误触发。", "Stops copying when the trader is losing badly, before your own loss limits trip. Uses the source's cumulative PnL, so deposits and withdrawals do not trigger it.")}</p>
        </div>
        <div className="shrink-0">
          <Toggle checked={on} onChange={(v) => set({ source_dd_pct: v ? "15" : null })} label={on ? tr("开启", "On") : tr("关闭", "Off")} />
        </div>
      </div>
      {on ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">{tr("从峰值回撤超过", "Drawdown from peak above")}</span>
            <NumInput className="w-24" value={risk.source_dd_pct ?? ""} onChange={(v) => set({ source_dd_pct: v })} suffix="%" invalid={invalid} />
            <span className="text-sm">{tr("触发后", "then")}</span>
            <Seg
              value={risk.source_dd_action ?? "pause"}
              onChange={(v) => set({ source_dd_action: v })}
              options={[
                { value: "pause", label: tr("暂停，保留仓位", "Pause, keep positions") },
                { value: "close", label: tr("平仓并暂停", "Close and pause") },
              ]}
            />
          </div>
          {invalid ? <p className="mt-2 text-xs text-danger">{tr("请填写 0–100 之间的百分比", "Enter a percentage between 0 and 100")}</p> : null}
          {address && hist != null && limit > 0 ? (
            <div className="mt-4 rounded-md border border-border px-4 py-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-fg">{tr("信号源近 30 天", "Source, last 30 days")}</span>
                <span className="num">{tr(`最大回撤 ${num(hist * 100, 1)}%`, `Max drawdown ${num(hist * 100, 1)}%`)}</span>
              </div>
              <div className="relative mt-3 h-2 rounded-full bg-muted">
                <div className="absolute inset-y-0 left-0 rounded-full bg-warning/70" style={{ width: `${Math.min((hist * 100) / scale, 1) * 100}%` }} />
                <div className="absolute -top-1 -bottom-1 w-0.5 bg-danger" style={{ left: `${Math.min(limit / scale, 1) * 100}%` }} />
              </div>
              <div className="mt-1.5 flex justify-between text-[11px] text-muted-fg">
                <span>{tr(`历史最大回撤 ${num(hist * 100, 1)}%`, `Max drawdown ${num(hist * 100, 1)}%`)}</span>
                <span className="text-danger">{tr(`熔断线 ${num(limit, 1)}%`, `Breaker ${num(limit, 1)}%`)}</span>
              </div>
              <p className={clsx("mt-2 text-xs", limit <= hist * 100 ? "text-warning" : "text-muted-fg")}>
                {limit <= hist * 100
                  ? tr("阈值低于该交易员近 30 天的最大回撤，正常波动也可能触发。", "The threshold is below this trader's 30-day max drawdown; normal swings may trip it.")
                  : tr("阈值高于该交易员近 30 天的最大回撤，正常波动不会触发。峰值从任务启动时开始记。", "The threshold is above this trader's 30-day max drawdown, so normal swings will not trip it. The peak is tracked from the task's start.")}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-fg">{tr("回撤 = (峰值累计盈亏 − 当前累计盈亏) ÷ 峰值时的信号源权益。峰值从任务启动时开始记，触发后恢复任务从当时重新记。", "Drawdown = (peak cumulative PnL − current) ÷ source equity at the peak. The peak is tracked from the task's start and again from each resume.")}</p>
          )}
        </>
      ) : null}
    </section>
  );
}

function ConfirmStep({
  name,
  setName,
  startNow,
  setStartNow,
  editing,
  converting,
  followers,
  setFollowers,
  rules,
  conns,
}: {
  name: string;
  setName: (s: string) => void;
  startNow: boolean;
  setStartNow: (b: boolean) => void;
  editing: boolean;
  converting: boolean;
  followers: FollowerSpec[];
  setFollowers: (f: FollowerSpec[]) => void;
  rules: Rules;
  conns: NonNullable<ReturnType<typeof useConnections>["data"]>;
}) {
  const tr = useTr();
  const watching = rules.mode === "watch";
  const allocated = rules.sizing.mode === "allocated";
  // Overrides keep the task's sizing mode; only k (or the capital) differs.
  const setOverride = (id: string, v: string | null) =>
    setFollowers(followers.map((f) => (f.connection_id === id ? { ...f, overrides: v === null ? null : { ...(f.overrides ?? {}), sizing: allocated ? { ...rules.sizing, capital: v } : { ...rules.sizing, k: v } } } : f)));
  const overrideOf = (f: FollowerSpec) => {
    const z = f.overrides?.sizing;
    if (!z || z.mode !== rules.sizing.mode) return "";
    return (allocated ? z.capital : z.k) ?? "";
  };
  return (
    <div className="flex max-w-[600px] flex-col gap-8">
      <section>
        <H>{tr("任务名称", "Task name")}</H>
        <Input value={name} onChange={(e) => setName(e.target.value)} invalid={!name.trim()} placeholder={tr("如：HL 聪明钱 #1", "e.g. HL smart money #1")} />
      </section>
      {watching ? (
        <section>
          <H>{tr("观察任务", "Watch task")}</H>
          <p className="text-sm text-muted-fg">{tr("不下单、不占本金。信号源的仓位变化记录在任务详情的信号列表里，并按勾选的类型推送。", "No orders and no capital. The source's position changes are listed on the task page and pushed by the types you picked.")}</p>
        </section>
      ) : null}
      {converting ? (
        <section className="rounded-md bg-primary-soft px-3 py-2 text-xs">
          {rules.start === "sync_existing"
            ? tr("保存后任务按信号源当前持仓重新开始，并立即市价开出这些仓位。", "On save the task restarts and opens the source's current positions at market right away.")
            : tr("保存后任务重新开始，信号源当前已有的持仓不跟，只跟之后新开的仓位。", "On save the task restarts; the source's current positions are left alone and only new ones are followed.")}
        </section>
      ) : null}
      <section className={clsx(watching && "hidden")}>
        <H hint={tr("不填则继承任务规则。", "Leave empty to inherit the task rules.")}>{allocated ? tr("按账户覆盖本金", "Per-account capital") : tr("按账户覆盖倍数", "Per-account multiple")}</H>
        <div className="flex flex-col">
          {followers.map((f) => {
            const c = conns.find((x) => x.id === f.connection_id);
            return (
              <div key={f.connection_id} className="flex items-center gap-3 border-b border-border py-2.5">
                {c ? <PlatformTag platform={c.platform} testnet={c.testnet} /> : null}
                <span className="flex-1 text-sm">{c?.alias}</span>
                {rules.sizing.mode === "fixed_notional" ? (
                  <span className="text-xs text-muted-fg">{tr("固定名义模式不支持覆盖倍数", "Not available for fixed notional")}</span>
                ) : allocated ? (
                  <NumInput className="w-36" value={overrideOf(f)} onChange={(v) => setOverride(f.connection_id, v === "" ? null : v)} placeholder={rules.sizing.capital ?? ""} suffix="USDT" />
                ) : (
                  <NumInput className="w-28" value={overrideOf(f)} onChange={(v) => setOverride(f.connection_id, v === "" ? null : v)} placeholder={`× ${rules.sizing.k}`} />
                )}
              </div>
            );
          })}
        </div>
      </section>
      {!editing ? (
        <section>
          <Toggle checked={startNow} onChange={setStartNow} label={tr("创建后立即启动", "Start right after creating")} />
          <p className="mt-2 text-xs text-muted-fg">
            {watching
              ? tr("启动后开始记录并推送信号源的仓位变化。", "Starts recording and pushing the source's position changes.")
              : rules.start === "sync_existing"
                ? tr("启动后将立即同步信号源已有持仓。", "Existing source positions will be synced immediately.")
                : tr("启动后只跟随之后新开的仓位。", "Only positions opened after start are followed.")}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function PreviewPanel({ loading, data, error, sourceLabel, empty }: { loading: boolean; data?: Awaited<ReturnType<typeof api.preview>>; error: string | null; sourceLabel: string; empty: boolean }) {
  const tr = useTr();
  const base = data?.sample_base;
  const allocated = !!data?.rows.some((r) => r.capital != null);
  const capitalSum = data?.rows.reduce((a, r) => a + Number(r.capital ?? 0), 0) ?? 0;
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
                {allocated ? <th className="text-right font-normal">{tr("本金", "Capital")}</th> : null}
                <th className="text-right font-normal">{tr("比例", "Ratio")}</th>
                <th className="text-right font-normal">{base ? tr(`${base} 目标`, `${base} target`) : tr("目标", "Target")}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.connection_id} className="border-b border-border">
                  <td className="py-2.5">
                    <div>{r.alias}</div>
                    <div className="num text-xs text-muted-fg">
                      {tr("可用", "Avail.")} {num(r.available, 0)} USDT
                    </div>
                  </td>
                  {allocated ? <td className="num text-right">{r.capital != null ? num(r.capital, 0) : "—"}</td> : null}
                  <td className="num text-right">{r.ratio_pct != null ? `${num(r.ratio_pct, 2)}%` : "—"}</td>
                  <td className="num text-right">{r.sample_target ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-6 flex flex-col gap-3">
            {data.rows
              .filter((r) => Number(r.other_capital ?? 0) > 0 && Number(r.capital ?? 0) + Number(r.other_capital ?? 0) <= Number(r.equity))
              .map((r) => (
                <div key={`cap-${r.connection_id}`} className="flex gap-2 text-xs">
                  <Check size={13} className="mt-0.5 shrink-0 text-success" />
                  <span>
                    {tr(
                      `${r.alias} 已有其他任务占用本金 ${num(r.other_capital, 0)} USDT；合计 ${num(Number(r.capital) + Number(r.other_capital), 0)}，低于账户权益 ${num(r.equity, 0)}，可以运行。`,
                      `${r.alias}: other tasks hold ${num(r.other_capital, 0)} USDT; ${num(Number(r.capital) + Number(r.other_capital), 0)} in total fits the ${num(r.equity, 0)} equity.`,
                    )}
                  </span>
                </div>
              ))}
            {data.warnings.map((w) => (
              <div key={w} className="flex gap-2 text-xs">
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
                <span>{w}</span>
              </div>
            ))}
          </div>
          <div className="flex-1" />
          <div className="border-t border-border pt-4 text-xs">
            {allocated ? (
              <div className="flex justify-between py-1">
                <span className="text-muted-fg">{tr("投入本金合计", "Total capital")}</span>
                <span className="num">{num(capitalSum, 0)} USDT</span>
              </div>
            ) : null}
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
