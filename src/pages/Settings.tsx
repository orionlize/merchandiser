import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { BarChart3, Check, ChevronRight, Copy, Download, Lock, ReceiptText, ScrollText, Search, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { OtpCells } from "../components/Otp";
import { ServerSetup } from "../components/ServerSetup";
import { Button, Dot, Field, Input, Loading, Modal, NumInput, Seg, Select, Toggle } from "../components/ui";
import { api, errMsg, type ChannelStatus, type NotifyConfig, type NotifyState, type OpLogRow, type Platform, type Settings as S, type SymbolRow, type TotpSetup, type WebhookFormat } from "../lib/api";
import { ago, date, pnlClass, signed, time } from "../lib/format";
import { useTr } from "../lib/i18n";
import { opLabel, SENSITIVE_GROUPS } from "../lib/ops";
import { qc, useAction, useHealth, useNotify, useOpLog, useOverview, useSettings, useTotp } from "../lib/queries";
import { downloadText, pickTextFile } from "../lib/files";
import { serverConfig } from "../lib/server";
import { applyTheme, useUi } from "../lib/store";

export function Settings() {
  const tr = useTr();
  const [sub, setSub] = useState<"general" | "symbols" | "notify" | "audit">("general");
  const items = [
    { v: "general" as const, l: tr("通用与安全", "General & security") },
    { v: "symbols" as const, l: tr("品种映射", "Symbol map") },
    { v: "notify" as const, l: tr("通知与心跳", "Notifications") },
    { v: "audit" as const, l: tr("操作审计", "Audit log") },
  ];
  return (
    <div className="flex h-full min-h-0 max-md:flex-col max-md:overflow-y-auto">
      <MoreHeader />
      <nav className="flex w-[170px] shrink-0 flex-col gap-1 px-4 py-6 max-md:w-full max-md:flex-row max-md:border-b max-md:border-border max-md:py-2">
        {items.map((i) => (
          <button key={i.v} onClick={() => setSub(i.v)} className={clsx("h-9 rounded-md px-3 text-left text-sm whitespace-nowrap transition-colors duration-150", sub === i.v ? "bg-muted text-fg" : "text-muted-fg hover:text-fg")}>
            {i.l}
          </button>
        ))}
      </nav>
      <div key={sub} className="anim-fade min-w-0 flex-1 px-4 py-4 md:overflow-y-auto md:px-6 md:py-6">
        {sub === "general" ? <General /> : sub === "symbols" ? <Symbols /> : sub === "notify" ? <Notify /> : <Audit />}
      </div>
    </div>
  );
}

/** Phone-only top of the "More" tab: e-stop, records and lock, which live in the sidebar on desktop. */
function MoreHeader() {
  const tr = useTr();
  const { go, toast } = useUi();
  const { data: h } = useHealth();
  const { data: ov } = useOverview();
  const estop = useAction(api.estop, { invalidate: [["health"], ["overview"]] });
  const lock = useAction(api.lock, {});
  const link = (label: string, right: ReactNode, tab: string, icon: ReactNode) => (
    <button onClick={() => go("records", tab)} className="flex h-12 w-full items-center gap-3 border-b border-border px-4 text-left text-sm last:border-b-0">
      <span className="text-muted-fg">{icon}</span>
      <span className="flex-1">{label}</span>
      <span className="num text-xs text-muted-fg">{right}</span>
      <ChevronRight size={14} className="text-muted-fg" />
    </button>
  );
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 md:hidden">
      <div className="flex items-center gap-3 border border-danger bg-danger-soft px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-danger">{h?.estopped ? tr("已急停", "E-stopped") : tr("全局急停", "E-stop")}</div>
          <div className="text-xs text-danger/80">{tr("暂停全部任务并撤销镜像挂单，不平仓", "Pause all tasks, cancel mirrors; positions stay")}</div>
        </div>
        <Button variant="danger" disabled={h?.estopped} loading={estop.isPending} onClick={() => estop.mutate(undefined)}>
          {tr("急停", "Stop")}
        </Button>
      </div>
      <div>
        <div className="mb-1.5 text-xs text-muted-fg">{tr("记录", "Records")}</div>
        <div className="border border-border bg-card">
          {link(tr("收益报表", "PnL report"), <span className={pnlClass(ov?.today_pnl)}>{tr("今日", "Today")} {signed(ov?.today_pnl)}</span>, "pnl", <BarChart3 size={16} />)}
          {link(tr("成交记录", "Fills"), ov ? tr(`今日 ${ov.today.orders} 笔`, `${ov.today.orders} today`) : "", "fills", <ReceiptText size={16} />)}
          {link(tr("执行日志", "Execution log"), ov && ov.today.failed > 0 ? <span className="text-danger">{tr(`${ov.today.failed} 条失败`, `${ov.today.failed} failed`)}</span> : "", "log", <ScrollText size={16} />)}
        </div>
      </div>
      <button
        className="flex h-11 items-center justify-between border border-border bg-card px-4 text-sm text-danger"
        onClick={async () => {
          const ok = await lock.mutateAsync(undefined);
          if (!ok) toast(tr("请先在下方开启应用锁并设置密码", "Enable the app lock below first"), "info");
        }}
      >
        <span className="flex items-center gap-3">
          <Lock size={16} />
          {tr("锁定界面", "Lock")}
        </span>
        <span className="text-xs text-muted-fg">v0.1.0</span>
      </button>
    </div>
  );
}

function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 border-b border-border py-3 md:gap-6">
      <div>
        <div className="text-sm">{title}</div>
        {hint ? <div className="mt-0.5 text-xs text-muted-fg">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function useSaveSettings() {
  const { toast, setLang, setTheme } = useUi();
  return async (s: S) => {
    try {
      const r = await api.setSettings(s);
      qc.setQueryData(["settings"], r);
      setLang(r.language);
      setTheme(r.theme);
      applyTheme(r.theme);
    } catch (e) {
      toast(errMsg(e), "error");
      qc.invalidateQueries({ queryKey: ["settings"] });
    }
  };
}

function ServerRow() {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  return (
    <Row title={tr("跟单服务器", "Server")} hint={serverConfig()?.url || tr("当前站点", "This site")}>
      <Button variant="link" onClick={() => setOpen(true)}>
        {tr("更改", "Change")}
      </Button>
      {open ? <ServerSetup onClose={() => setOpen(false)} /> : null}
    </Row>
  );
}

function General() {
  const tr = useTr();
  const toast = useUi((s) => s.toast);
  const { data: s } = useSettings();
  const { data: h } = useHealth();
  const saveS = useSaveSettings();
  const [pwOpen, setPwOpen] = useState(false);
  if (!s) return <Loading />;
  const set = (p: Partial<S>) => saveS({ ...s, ...p });

  return (
    <div className="max-w-[560px]">
      <h2 className="mb-1 text-md font-semibold">{tr("通用", "General")}</h2>
      <Row title={tr("语言", "Language")}>
        <Seg value={s.language} onChange={(v) => set({ language: v })} options={[{ value: "zh", label: "简体中文" }, { value: "en", label: "English" }]} />
      </Row>
      <Row title={tr("主题", "Theme")}>
        <Seg
          value={s.theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { value: "dark", label: tr("深色", "Dark") },
            { value: "light", label: tr("浅色", "Light") },
            { value: "system", label: tr("跟随系统", "System") },
          ]}
        />
      </Row>
      <ServerRow />

      <h2 className="mt-8 mb-1 text-md font-semibold">{tr("安全", "Security")}</h2>
      <Row title={tr("应用锁", "App lock")} hint={tr("启动密码与闲置自动锁定；锁定期间任务继续运行", "Password at launch and idle lock; tasks keep running while locked")}>
        <Toggle
          checked={s.app_lock}
          onChange={async (v) => {
            if (v) setPwOpen(true);
            else {
              await api.setLockPassword(null);
              qc.invalidateQueries({ queryKey: ["settings"] });
              toast(tr("已关闭应用锁", "App lock off"));
            }
          }}
        />
      </Row>
      {s.app_lock ? (
        <Row title={tr("闲置自动锁定", "Idle lock after")}>
          <Select
            value={String(s.idle_lock_minutes)}
            onChange={(v) => set({ idle_lock_minutes: Number(v) })}
            options={[5, 15, 30, 60, 0].map((m) => ({ value: String(m), label: m === 0 ? tr("从不", "Never") : tr(`${m} 分钟`, `${m} min`) }))}
          />
        </Row>
      ) : null}
      <TwoFactor />
      <Row
        title={tr("密钥存储", "Key storage")}
        hint={tr("API 密钥、两步验证密钥、通知渠道令牌都由主密码加密（Argon2id）存在服务器上；客户端永远拿不到明文", "API keys, the 2FA secret and notification tokens are encrypted with the master password (Argon2id) on the server; the client never sees plaintext")}
      >
        <span className="flex items-center gap-1.5 text-xs">
          <Dot color={h?.secrets_locked ? "warning" : "success"} />
          {h?.secrets_locked ? tr("未解锁", "Locked") : tr("正常", "OK")}
        </span>
      </Row>

      <h2 className="mt-8 mb-1 text-md font-semibold">{tr("数据", "Data")}</h2>
      <h3 className="mt-2 text-sm font-semibold">{tr("数据保留", "Retention")}</h3>
      <Row title={tr("执行日志与成交", "Logs and fills")} hint={tr("信号、订单、告警、权益曲线", "Signals, orders, alerts, equity curves")}>
        <RetentionSelect value={s.log_retention_days} onChange={(v) => set({ log_retention_days: v })} days={[30, 90, 180, 365]} />
      </Row>
      <Row title={tr("历史仓位与费用", "Position history and costs")} hint={tr("已平仓记录、手续费与资金费明细", "Closed positions, fee and funding records")}>
        <RetentionSelect value={s.trip_retention_days ?? 365} onChange={(v) => set({ trip_retention_days: v })} days={[90, 180, 365, 730]} />
      </Row>
      <Row title={tr("操作审计", "Audit log")} hint={tr("「操作审计」页的记录", "What the Audit log page lists")}>
        <RetentionSelect value={s.audit_retention_days ?? 180} onChange={(v) => set({ audit_retention_days: v })} days={[30, 90, 180, 365]} />
      </Row>
      <p className="py-2 text-xs text-muted-fg">{tr("每天清理一次过期数据；选「永久」则不清理。缩短期限后旧数据在下次清理时删除，无法恢复。", "Expired data is cleared once a day; Forever keeps everything. After shortening a period, older data goes at the next clean-up and cannot be recovered.")}</p>
      <Row title={tr("配置导入导出（不含密钥）", "Import / export config (no keys)")}>
        <div className="flex gap-4">
          <Button
            variant="link"
            onClick={async () => {
              try {
                const text = await pickTextFile("application/json,.json");
                if (text == null) return;
                toast(await api.importConfig(JSON.parse(text)));
                qc.invalidateQueries();
              } catch (e) {
                toast(errMsg(e), "error");
              }
            }}
          >
            {tr("导入", "Import")}
          </Button>
          <Button
            variant="link"
            onClick={async () => {
              try {
                const cfg = await api.exportConfig();
                downloadText("merchandiser-config.json", JSON.stringify(cfg, null, 2), "application/json");
                toast(tr("已导出", "Exported"));
              } catch (e) {
                toast(errMsg(e), "error");
              }
            }}
          >
            {tr("导出", "Export")}
          </Button>
        </div>
      </Row>
      <PasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

function RetentionSelect({ value, onChange, days }: { value: number; onChange: (v: number) => void; days: number[] }) {
  const tr = useTr();
  const opts = Array.from(new Set([...days, value].filter((d) => d > 0))).sort((a, b) => a - b);
  return (
    <Select
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={[...opts.map((d) => ({ value: String(d), label: d % 365 === 0 ? tr(`${d / 365} 年`, `${d / 365} yr`) : tr(`${d} 天`, `${d} days`) })), { value: "0", label: tr("永久", "Forever") }]}
    />
  );
}

/** Groups a base32 secret in fours for reading off the screen. */
const groups = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const tr = useTr();
  const toast = useUi((s) => s.toast);
  const text = codes.join("\n");
  return (
    <div className="my-3 rounded-md border border-warning/40 bg-card px-4 py-4">
      <div className="text-sm font-semibold">{tr("恢复码（只显示这一次）", "Recovery codes (shown once)")}</div>
      <p className="mt-1 text-xs text-muted-fg">{tr("验证器丢失时，用任意一个恢复码代替动态码；每个只能用一次。", "If you lose the authenticator, any one of these replaces a code; each works once.")}</p>
      <div className="num mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm md:grid-cols-5">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => downloadText("merchandiser-recovery-codes.txt", `Merchandiser recovery codes\n${new Date().toISOString()}\n\n${text}\n`, "text/plain")}>
          <Download size={13} />
          {tr("下载 .txt", "Download .txt")}
        </Button>
        <Button
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast(tr("已复制", "Copied"));
            } catch {
              toast(tr("复制失败，请手动抄写", "Copy failed; write them down"), "error");
            }
          }}
        >
          <Copy size={13} />
          {tr("复制全部", "Copy all")}
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="primary" onClick={onDone}>
          {tr("我已保存", "I've saved them")}
        </Button>
      </div>
    </div>
  );
}

function TwoFactor() {
  const tr = useTr();
  const toast = useUi((s) => s.toast);
  const { data: st } = useTotp();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const [busy, setBusy] = useState<"setup" | "enable" | "disable" | "regen" | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["totp"] });
    qc.invalidateQueries({ queryKey: ["health"] });
  };
  const run = async <T,>(k: NonNullable<typeof busy>, f: () => Promise<T>) => {
    setBusy(k);
    try {
      return await f();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "otp_cancelled") toast(errMsg(e), "error");
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  const enable = async (v = code) => {
    if (v.length !== 6 || busy) return;
    setBusy("enable");
    try {
      const r = await api.totpEnable(v);
      setCodes(r.recovery_codes);
      setSetup(null);
      setCode("");
      setBad(null);
      refresh();
      toast(tr("两步验证已开启", "Two-step verification on"));
    } catch (e) {
      setBad(errMsg(e));
      setCode("");
    } finally {
      setBusy(null);
    }
  };
  if (!st) return null;
  const tag = st.enabled ? (
    <span className="inline-flex h-5 items-center gap-1 rounded-sm bg-success-soft px-1.5 text-[11px] text-success">
      <ShieldCheck size={11} />
      {tr("已开启", "On")}
    </span>
  ) : setup ? (
    <span className="inline-flex h-5 items-center rounded-sm bg-primary-soft px-1.5 text-[11px] text-primary">{tr("设置中", "Setting up")}</span>
  ) : null;
  return (
    <div className="border-b border-border py-3">
      <div className="flex min-h-8 items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm">
            {tr("两步验证（TOTP）", "Two-step verification (TOTP)")}
            {tag}
          </div>
          <div className="mt-0.5 text-xs text-muted-fg">{tr("用 Google Authenticator、1Password、Authy 等验证器生成 6 位动态码。开启后解锁界面和敏感操作都要输入动态码。", "An authenticator app (Google Authenticator, 1Password, Authy…) makes 6-digit codes. Once on, unlocking and sensitive actions ask for one.")}</div>
        </div>
        <div className="shrink-0">
          {st.enabled ? null : setup ? (
            <Button variant="link" onClick={() => (setSetup(null), setCode(""), setBad(null))}>
              {tr("取消", "Cancel")}
            </Button>
          ) : (
            <Button disabled={st.secrets_locked} loading={busy === "setup"} onClick={async () => setSetup((await run("setup", api.totpSetup)) ?? null)}>
              {tr("开启", "Set up")}
            </Button>
          )}
        </div>
      </div>
      {st.secrets_locked && !st.enabled ? <p className="mt-2 text-xs text-warning">{tr("密钥库未解锁，暂不能设置两步验证。", "Unlock the key file before setting this up.")}</p> : null}

      {setup ? (
        <div className="mt-3 flex gap-5 rounded-md border border-border bg-card p-4 max-md:flex-col">
          <img src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr_svg)}`} alt={tr("两步验证二维码", "2FA QR code")} className="h-40 w-40 shrink-0 rounded-md bg-white p-2 max-md:self-center" />
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div>
              <div className="text-xs text-muted-fg">{tr("1. 用验证器扫描二维码，或手动输入密钥", "1. Scan the code with your authenticator, or type the key")}</div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="num rounded-md bg-muted px-2 py-1 text-sm break-all">{groups(setup.secret)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(setup.secret);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch {
                      /* clipboard unavailable */
                    }
                  }}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {tr("复制", "Copy")}
                </Button>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-fg">{tr("2. 输入验证器里显示的 6 位动态码", "2. Enter the 6-digit code it shows")}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <OtpCells value={code} onChange={(v) => (setCode(v), setBad(null))} onComplete={(v) => enable(v)} autoFocus invalid={!!bad} disabled={busy === "enable"} />
                <Button variant="primary" disabled={code.length !== 6} loading={busy === "enable"} onClick={() => enable()}>
                  {tr("验证并开启", "Verify and turn on")}
                </Button>
              </div>
              {bad ? <p className="mt-1.5 text-xs text-danger">{bad}</p> : null}
            </div>
            <p className="text-xs text-muted-fg">{tr("密钥与口令一样由主密码加密保存；服务器时间偏差超过 30 秒会导致校验失败。", "The key is encrypted with the master password like your API keys; a server clock more than 30 s off makes codes fail.")}</p>
          </div>
        </div>
      ) : null}

      {codes ? <RecoveryCodes codes={codes} onDone={() => setCodes(null)} /> : null}

      {st.enabled && !codes ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className={clsx("text-xs", st.recovery_left <= 2 ? "text-warning" : "text-muted-fg")}>{tr(`剩余 ${st.recovery_left} 个恢复码`, `${st.recovery_left} recovery codes left`)}</span>
          <Button
            variant="link"
            className="text-xs"
            loading={busy === "regen"}
            onClick={async () => {
              const r = await run("regen", api.totpRecoveryRegen);
              if (r) {
                setCodes(r.recovery_codes);
                refresh();
              }
            }}
          >
            {tr("重新生成", "Regenerate")}
          </Button>
          <div className="flex-1" />
          <Button variant="danger-text" className="text-xs" onClick={() => setConfirmOff(true)}>
            {tr("关闭两步验证", "Turn off")}
          </Button>
        </div>
      ) : null}

      <div className="mt-4">
        <div className="text-xs text-muted-fg">{tr("需要动态码的操作", "Actions that need a code")}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SENSITIVE_GROUPS.map((g) => (
            <span key={g.zh} className={clsx("inline-flex h-7 items-center rounded-md px-2.5 text-xs", st.enabled ? "bg-muted text-fg" : "bg-muted text-muted-fg")}>
              {tr(g.zh, g.en)}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-fg">{tr("验证通过后 5 分钟内不再重复询问。急停不需要动态码，紧急时不会被挡住。", "After a code, you are not asked again for 5 minutes. The emergency stop never asks, so it is never in the way.")}</p>
      </div>

      <Modal
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title={tr("关闭两步验证？", "Turn off two-step verification?")}
        footer={
          <>
            <Button onClick={() => setConfirmOff(false)}>{tr("取消", "Cancel")}</Button>
            <Button
              variant="danger"
              loading={busy === "disable"}
              onClick={async () => {
                const ok = await run("disable", async () => (await api.totpDisable(), true));
                if (ok) {
                  setConfirmOff(false);
                  refresh();
                  toast(tr("两步验证已关闭", "Two-step verification off"));
                }
              }}
            >
              {tr("关闭", "Turn off")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-fg">{tr("关闭后解锁界面和敏感操作只需要密码。下一步会要求输入当前的动态码。", "Unlocking and sensitive actions will need only the password. You will be asked for a current code next.")}</p>
      </Modal>
    </div>
  );
}

const AUDIT_RANGES = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, all: 0 } as const;

function Audit() {
  const tr = useTr();
  const en = useUi((s) => s.lang) === "en";
  const toast = useUi((s) => s.toast);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "sensitive" | "failed">("all");
  const [range, setRange] = useState<keyof typeof AUDIT_RANGES>("7d");
  const [limit, setLimit] = useState(100);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  // Snap to the minute so the query key stays stable.
  const since = AUDIT_RANGES[range] ? Math.floor((Date.now() - AUDIT_RANGES[range] * 86_400_000) / 60_000) * 60_000 : undefined;
  const filter = { since, sensitive: kind === "sensitive" || undefined, failed: kind === "failed" || undefined, query: query || undefined, limit };
  const { data, isLoading } = useOpLog(filter);
  const { data: failed } = useOpLog({ since, failed: true, limit: 1000 });
  const rows = data ?? [];

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await api.opLog({ ...filter, limit: 5000 });
      const esc = (v: string | number | boolean | null) => {
        const x = v == null ? "" : String(v);
        return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
      };
      const head = ["time", "command", "action", "summary", "ok", "error", "otp", "sensitive", "ip", "user_agent"];
      const lines = all.map((r) => [new Date(r.ts).toISOString(), r.command, opLabel(r.command, en), r.summary, r.ok, r.error, r.otp, r.sensitive, r.ip, r.ua].map(esc).join(","));
      downloadText(`merchandiser-audit-${new Date().toISOString().slice(0, 10)}.csv`, [head.join(","), ...lines].join("\n"), "text/csv");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setExporting(false);
    }
  };

  const result = (r: OpLogRow) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx("inline-flex h-5 items-center px-1.5 text-[11px]", r.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>{r.ok ? tr("成功", "OK") : tr("失败", "Failed")}</span>
      {r.otp ? <span className="inline-flex h-5 items-center bg-primary-soft px-1.5 text-[11px] text-primary">2FA</span> : null}
    </span>
  );
  const summary = (r: OpLogRow) => (r.ok ? r.summary || "—" : r.error || r.summary || "—");

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex h-8 w-64 items-center gap-2 rounded-md border border-input bg-bg px-3 max-md:w-full">
          <Search size={13} className="shrink-0 text-muted-fg" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setLimit(100);
            }}
            placeholder={tr("搜索操作、摘要或 IP", "Search actions, summaries or IPs")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-fg"
          />
        </div>
        <Seg
          size="sm"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setLimit(100);
          }}
          options={[
            { value: "all", label: tr("全部", "All") },
            { value: "sensitive", label: tr("敏感操作", "Sensitive") },
            { value: "failed", label: tr(`失败 ${failed?.length ?? ""}`, `Failed ${failed?.length ?? ""}`) },
          ]}
        />
        <Select
          value={range}
          onChange={(v) => {
            setRange(v);
            setLimit(100);
          }}
          options={[
            { value: "1d", label: tr("近 24 小时", "Last 24 h") },
            { value: "7d", label: tr("近 7 天", "Last 7 days") },
            { value: "30d", label: tr("近 30 天", "Last 30 days") },
            { value: "90d", label: tr("近 90 天", "Last 90 days") },
            { value: "all", label: tr("全部", "All time") },
          ]}
        />
        <div className="flex-1" />
        <Button size="sm" loading={exporting} disabled={!rows.length} onClick={exportCsv}>
          <Download size={13} />
          {tr("导出 CSV", "Export CSV")}
        </Button>
      </div>
      {isLoading && !data ? (
        <Loading />
      ) : !rows.length ? (
        <div className="border border-border bg-card py-12 text-center text-sm text-muted-fg">{query || kind !== "all" ? tr("没有匹配的记录", "Nothing matches") : tr("这段时间没有改动类操作", "No changes in this period")}</div>
      ) : (
        <>
          <div className="border border-border bg-card max-md:hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-fg">
                  <th className="px-4 py-2.5 text-left font-normal">{tr("时间", "Time")}</th>
                  <th className="text-left font-normal">{tr("操作", "Action")}</th>
                  <th className="text-left font-normal">{tr("摘要", "Summary")}</th>
                  <th className="text-left font-normal">{tr("结果", "Result")}</th>
                  <th className="px-4 text-left font-normal">{tr("来源", "From")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border align-top last:border-b-0">
                    <td className="num px-4 py-2.5 text-xs whitespace-nowrap text-muted-fg">
                      {date(r.ts)} {time(r.ts)}
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-1.5 whitespace-nowrap">
                        {opLabel(r.command, en)}
                        {r.sensitive ? <span className="h-1.5 w-1.5 rounded-full bg-primary" title={tr("敏感操作", "Sensitive")} /> : null}
                      </div>
                      <div className="num text-xs text-muted-fg">{r.command}</div>
                    </td>
                    <td className={clsx("max-w-[340px] py-2.5 pr-3 text-xs break-words", r.ok ? "text-fg" : "text-danger")}>{summary(r)}</td>
                    <td className="py-2.5 whitespace-nowrap">{result(r)}</td>
                    <td className="num px-4 py-2.5 text-xs whitespace-nowrap text-muted-fg" title={r.ua ?? undefined}>
                      {r.ip || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-2 md:hidden">
            {rows.map((r) => (
              <div key={r.id} className="border border-border bg-card px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-semibold">{opLabel(r.command, en)}</span>
                  {result(r)}
                </div>
                <div className={clsx("mt-1 text-xs break-words", r.ok ? "text-fg" : "text-danger")}>{summary(r)}</div>
                <div className="num mt-1 flex justify-between gap-3 text-xs text-muted-fg">
                  <span>
                    {date(r.ts)} {time(r.ts)}
                  </span>
                  <span className="truncate">{r.ip || ""}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-fg">
            <span>{tr("记录所有改动类操作；请求里的密钥、密码和动态码会被脱敏，审计记录不可修改", "Every change is recorded; keys, passwords and codes in requests are redacted, and entries cannot be edited")}</span>
            {rows.length >= limit ? (
              <Button size="sm" onClick={() => setLimit((l) => l + 100)}>
                {tr("加载更多", "Load more")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tr = useTr();
  const toast = useUi((s) => s.toast);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const mismatch = b.length > 0 && a !== b;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr("设置应用锁密码", "Set app lock password")}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button
            variant="primary"
            disabled={a.length < 4 || a !== b}
            onClick={async () => {
              try {
                await api.setLockPassword(a);
                qc.invalidateQueries({ queryKey: ["settings"] });
                toast(tr("应用锁已开启", "App lock on"));
                setA("");
                setB("");
                onClose();
              } catch (e) {
                toast(errMsg(e), "error");
              }
            }}
          >
            {tr("开启", "Enable")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={tr("密码（至少 4 位）", "Password (4+ chars)")}>
          <Input type="password" value={a} onChange={(e) => setA(e.target.value)} autoFocus />
        </Field>
        <Field label={tr("再次输入", "Repeat")} error={mismatch ? tr("两次输入不一致", "Passwords differ") : null}>
          <Input type="password" value={b} onChange={(e) => setB(e.target.value)} invalid={mismatch} />
        </Field>
      </div>
    </Modal>
  );
}

const PLATS: Platform[] = ["hyperliquid"];

function Symbols() {
  const tr = useTr();
  const toast = useUi((s) => s.toast);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<{ base: string; platform: Platform; symbol: string } | null>(null);
  const { data, isFetching, refetch } = useQuery({ queryKey: ["symbols", q], queryFn: () => api.symbolMap(q), staleTime: 60_000 });
  const { data: updated } = useQuery({ queryKey: ["symbols", "updated"], queryFn: api.symbolsUpdatedAt });
  const [regen, setRegen] = useState(false);

  const cell = (r: SymbolRow, p: Platform) => {
    const c = r.cells[p];
    if (!c?.symbol) return <span className="text-muted-fg">{tr("无对应合约", "None")}</span>;
    const cpu = Number(c.coin_per_unit);
    const pxu = Number(c.px_unit);
    let suffix = "";
    if (cpu !== 1) suffix = ` × ${fmtMult(cpu)}`;
    else if (pxu !== 1) suffix = ` ÷ ${fmtMult(pxu)}`;
    return (
      <span className={clsx(c.manual && "text-primary")}>
        {c.symbol}
        <span className="text-muted-fg">{suffix}</span>
      </span>
    );
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-md font-semibold">{tr("品种映射", "Symbol map")}</h2>
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-48 items-center gap-2 rounded-md border border-input bg-bg px-3">
            <Search size={13} className="text-muted-fg" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("搜索币种", "Search coin")} className="flex-1 bg-transparent text-sm outline-none" />
          </div>
          <Button
            loading={regen}
            onClick={async () => {
              setRegen(true);
              try {
                await api.regenerateSymbols();
                await refetch();
                qc.invalidateQueries({ queryKey: ["symbols", "updated"] });
                toast(tr("已重新生成", "Regenerated"));
              } catch (e) {
                toast(errMsg(e), "error");
              } finally {
                setRegen(false);
              }
            }}
          >
            {tr("重新生成", "Regenerate")}
          </Button>
        </div>
      </div>
      <p className="mb-4 text-xs text-muted-fg">
        {tr("启动时从 Hyperliquid 拉取合约列表自动生成，内部统一用币的数量。点击单元格可手动修正。", "Built from Hyperliquid's contract list; quantities are normalised to coins internally. Click a cell to correct it.")}
        {updated ? tr(` 上次更新 ${time(updated)}。`, ` Updated ${time(updated)}.`) : ""}
      </p>
      {isFetching && !data ? (
        <Loading />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-fg">
                <th className="px-4 py-2.5 font-normal">{tr("基础币种", "Base")}</th>
                <th className="px-2 font-normal">Hyperliquid</th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).slice(0, 120).map((r) => (
                <tr key={r.base} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">
                    {r.base}
                    {r.manual ? <span className="ml-2 bg-primary-soft px-1 text-[11px] text-primary">{tr("已手动修正", "Edited")}</span> : null}
                  </td>
                  {PLATS.map((p) => (
                    <td key={p} className="num cursor-pointer px-2 text-xs hover:bg-muted" onClick={() => setEditing({ base: r.base, platform: p, symbol: r.cells[p]?.symbol ?? "" })}>
                      {cell(r, p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={tr(`修正 ${editing?.base} · ${editing?.platform}`, `Edit ${editing?.base} · ${editing?.platform}`)}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={async () => {
                await api.setSymbolOverride(editing!.base, editing!.platform, null, false, true);
                setEditing(null);
                refetch();
              }}
            >
              {tr("恢复自动", "Reset")}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await api.setSymbolOverride(editing!.base, editing!.platform, null, true);
                setEditing(null);
                refetch();
              }}
            >
              {tr("标记为无对应", "Mark unmapped")}
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await api.setSymbolOverride(editing!.base, editing!.platform, editing!.symbol, false);
                  setEditing(null);
                  refetch();
                } catch (e) {
                  toast(errMsg(e), "error");
                }
              }}
            >
              {tr("保存", "Save")}
            </Button>
          </>
        }
      >
        <Field label={tr("平台合约代码", "Venue symbol")} hint={tr("如 1000PEPEUSDT、PEPE-USDT-SWAP、kPEPE。乘数从合约规格自动读取。", "e.g. 1000PEPEUSDT, PEPE-USDT-SWAP, kPEPE. Multipliers come from the contract spec.")}>
          <Input className="num" value={editing?.symbol ?? ""} onChange={(e) => setEditing((x) => (x ? { ...x, symbol: e.target.value.trim() } : x))} />
        </Field>
      </Modal>
    </div>
  );
}

function fmtMult(n: number) {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}K`;
  return String(n);
}

type Channel = "telegram" | "webhook" | "heartbeat" | "report";

const FORMAT_LABELS: Record<WebhookFormat, [string, string]> = {
  generic: ["通用 JSON", "Generic JSON"],
  feishu: ["飞书", "Feishu"],
  dingtalk: ["钉钉", "DingTalk"],
  wecom: ["企业微信", "WeCom"],
  discord: ["Discord", "Discord"],
  slack: ["Slack", "Slack"],
};

function StatusLine({ st, what }: { st: ChannelStatus; what: string }) {
  const tr = useTr();
  const en = useUi((s) => s.lang) === "en";
  if (!st.last_at) return <span className="text-xs text-muted-fg">{tr(`尚未${what}`, "Nothing sent yet")}</span>;
  return st.last_ok ? (
    <span className="flex items-center gap-1.5 text-xs text-muted-fg">
      <Dot />
      {tr(`上次${what} ${ago(st.last_at)}`, `Last ${ago(st.last_at, true)}`)}
      {st.last_ms != null ? `，${st.last_ms} ms` : ""}
      {st.last_code ? `，HTTP ${st.last_code}` : ""}
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-xs text-danger">
      <Dot color="danger" />
      {en ? `Failed ${ago(st.last_at, true)}: ` : `${ago(st.last_at)}失败：`}
      {st.last_error}
    </span>
  );
}

function ChannelCard({ title, hint, on, onToggle, status, children }: { title: ReactNode; hint?: ReactNode; on: boolean; onToggle: (v: boolean) => void; status?: ReactNode; children: ReactNode }) {
  return (
    <div className={clsx("rounded-lg border px-4 py-4 transition-colors duration-150", on ? "border-border bg-card" : "border-border")}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          {status ? <div className="mt-1">{status}</div> : hint ? <div className="mt-1 text-xs text-muted-fg">{hint}</div> : null}
        </div>
        <Toggle checked={on} onChange={onToggle} />
      </div>
      {on ? <div className="mt-4 flex flex-col gap-3">{children}</div> : null}
    </div>
  );
}

function Notify() {
  const tr = useTr();
  const toast = useUi((s) => s.toast);
  const { data: s } = useSettings();
  const saveS = useSaveSettings();
  const { data: n } = useNotify();
  const [draft, setDraft] = useState<NotifyConfig | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [busy, setBusy] = useState<Channel | "save" | null>(null);
  // Take the server's config the first time it loads (and after a save).
  const adopt = (x: NotifyState) => {
    setDraft(x.config);
    setSaved(JSON.stringify(x.config));
  };
  useEffect(() => {
    if (n && !draft) adopt(n);
  }, [n, draft]);
  if (!s || !n || !draft) return <Loading />;
  const dirty = JSON.stringify(draft) !== saved;
  const set = <K extends keyof NotifyConfig>(k: K, v: Partial<NotifyConfig[K]>) => setDraft({ ...draft, [k]: { ...draft[k], ...v } });
  const hint = (h: string | null) => (h ? tr(`${h}（已保存，留空不改）`, `${h} (saved; leave empty to keep)`) : "");

  const test = async (ch: Channel) => {
    setBusy(ch);
    try {
      const r = await api.testNotify(ch, draft);
      toast(tr(`测试成功，耗时 ${r.ms} ms`, `Sent in ${r.ms} ms`));
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ["notify"] });
    }
  };
  const save = async () => {
    setBusy("save");
    try {
      adopt(await api.setNotify(draft));
      qc.invalidateQueries({ queryKey: ["notify"] });
      toast(tr("通知设置已保存", "Notification settings saved"));
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const events: { k: keyof NotifyConfig["events"]; t: string; h: string }[] = [
    { k: "error", t: tr("下单失败与引擎错误", "Failed orders and engine errors"), h: tr("重试 3 次仍失败、任务恢复失败、服务器挂起", "Orders failing after 3 retries, failed restores, server suspended") },
    { k: "risk", t: tr("风控触发", "Risk triggers"), h: tr("亏损上限、盈利目标、单仓止盈止损、信号源回撤熔断、信号源失联、急停", "Loss limits, profit targets, per-position TP / SL, source drawdown breaker, source lost, e-stop") },
    { k: "lifecycle", t: tr("任务启停与恢复", "Task lifecycle"), h: tr("任务启动、暂停、停止，信号源恢复，服务重启", "Task start, pause and stop, source recovered, server restart") },
    { k: "trade", t: tr("每次成交", "Every fill"), h: tr("每一笔跟单、止盈止损与平仓成交；成交频繁时消息较多", "Every copy, TP / SL and close fill; noisy for active sources") },
    { k: "signal", t: tr("观察任务的信号", "Watch-only signals"), h: tr("观察模式任务按各自的筛选条件推送信号源的开平仓", "Source opens and closes from watch-only tasks, filtered per task") },
  ];

  return (
    <div className="flex gap-8">
      <div className="min-w-0 max-w-[600px] flex-1">
        <h2 className="mb-3 text-md font-semibold">{tr("推送渠道", "Channels")}</h2>
        <div className="flex flex-col gap-3">
          <ChannelCard title="Telegram Bot" hint={tr("通过 @BotFather 创建机器人，把它拉进群或私聊后填写 Chat ID", "Create a bot with @BotFather, add it to a chat, then fill in the chat id")} on={draft.telegram.enabled} onToggle={(v) => set("telegram", { enabled: v })} status={draft.telegram.enabled ? <StatusLine st={n.status.telegram} what={tr("推送", "sent")} /> : undefined}>
            <Field label="Bot Token">
              <Input type="password" autoComplete="off" value={draft.telegram.token} onChange={(e) => set("telegram", { token: e.target.value })} placeholder={hint(n.hints.telegram_token) || "123456:ABC…"} />
            </Field>
            <div className="flex items-end gap-3">
              <Field label="Chat ID" className="flex-1">
                <Input className="num" value={draft.telegram.chat_id} onChange={(e) => set("telegram", { chat_id: e.target.value.trim() })} placeholder="-1002233445566" />
              </Field>
              <Button loading={busy === "telegram"} onClick={() => test("telegram")}>
                {tr("发送测试", "Send test")}
              </Button>
            </div>
          </ChannelCard>

          <ChannelCard title="Webhook" hint={tr("飞书、钉钉、企业微信、Discord、Slack 的群机器人，或任意接收 JSON 的地址", "Chat-app robots or any URL that accepts JSON")} on={draft.webhook.enabled} onToggle={(v) => set("webhook", { enabled: v })} status={draft.webhook.enabled ? <StatusLine st={n.status.webhook} what={tr("推送", "sent")} /> : undefined}>
            <div className="flex flex-wrap gap-1.5">
              {n.formats.map((f) => (
                <button key={f} onClick={() => set("webhook", { format: f })} className={clsx("h-7 rounded-md border px-2.5 text-xs transition-colors duration-150", draft.webhook.format === f ? "border-fg bg-muted text-fg" : "border-border text-muted-fg hover:text-fg")}>
                  {tr(FORMAT_LABELS[f][0], FORMAT_LABELS[f][1])}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-3">
              <Field label={tr("Webhook 地址", "Webhook URL")} className="flex-1" hint={draft.webhook.format === "dingtalk" ? tr("钉钉机器人请把安全设置设为自定义关键词「Merchandiser」", "For DingTalk, set the robot's keyword to “Merchandiser”") : undefined}>
                <Input className="num" autoComplete="off" value={draft.webhook.url} onChange={(e) => set("webhook", { url: e.target.value.trim() })} placeholder={hint(n.hints.webhook_url) || "https://"} />
              </Field>
              <Button loading={busy === "webhook"} onClick={() => test("webhook")}>
                {tr("发送测试", "Send test")}
              </Button>
            </div>
          </ChannelCard>

          <Row title={tr("浏览器通知", "Browser notifications")} hint={tr("页面打开时弹出系统通知（HTTPS 或 localhost 下可用）", "System notifications while the page is open (HTTPS or localhost)")}>
            <Toggle checked={s.notifications} onChange={(v) => saveS({ ...s, notifications: v })} />
          </Row>
        </div>

        <h2 className="mt-8 mb-1 text-md font-semibold">{tr("推送哪些事件", "Events")}</h2>
        {events.map((e) => (
          <Row key={e.k} title={e.t} hint={e.h}>
            <Toggle checked={draft.events[e.k] ?? true} onChange={(v) => set("events", { [e.k]: v })} />
          </Row>
        ))}

        <h2 className="mt-8 mb-3 text-md font-semibold">{tr("每日报告与心跳", "Daily report and heartbeat")}</h2>
        <div className="flex flex-col gap-3">
          <ChannelCard title={tr("每日报告", "Daily report")} hint={tr("汇总昨日盈亏、成交、失败与各任务表现，按服务器时区发送到上面开启的渠道", "Yesterday's PnL, fills, failures and best / worst task, sent at server time to the channels above")} on={draft.daily.enabled} onToggle={(v) => set("daily", { enabled: v })} status={draft.daily.enabled && n.status.daily_last ? <span className="text-xs text-muted-fg">{tr(`上次发送 ${n.status.daily_last}`, `Last sent ${n.status.daily_last}`)}</span> : undefined}>
            <div className="flex items-end gap-3">
              <Field label={tr("发送时间", "Send at")}>
                <Input type="time" className="num w-32" value={draft.daily.at} onChange={(e) => set("daily", { at: e.target.value })} />
              </Field>
              <Button loading={busy === "report"} onClick={() => test("report")}>
                {tr("立即发送一份", "Send one now")}
              </Button>
            </div>
          </ChannelCard>
          <ChannelCard title={tr("心跳外发", "Outbound heartbeat")} hint={tr("引擎正常运行时定时请求该地址；外部监控收不到即告警，可发现服务器宕机或断网", "Pings this URL while the engine runs; an outside monitor alerts when pings stop")} on={draft.heartbeat.enabled} onToggle={(v) => set("heartbeat", { enabled: v })} status={draft.heartbeat.enabled ? <StatusLine st={n.status.heartbeat} what={tr("发送", "sent")} /> : undefined}>
            <Field label={tr("心跳地址（如 healthchecks.io、Uptime Kuma 推送地址）", "Ping URL (healthchecks.io, Uptime Kuma push, …)")}>
              <Input className="num" autoComplete="off" value={draft.heartbeat.url} onChange={(e) => set("heartbeat", { url: e.target.value.trim() })} placeholder={hint(n.hints.heartbeat_url) || "https://hc-ping.com/…"} />
            </Field>
            <div className="flex items-end gap-3">
              <Field label={tr("间隔", "Every")}>
                <NumInput className="w-28" value={String(draft.heartbeat.interval_secs)} onChange={(v) => set("heartbeat", { interval_secs: Number(v) || 0 })} suffix={tr("秒", "s")} />
              </Field>
              <Button loading={busy === "heartbeat"} onClick={() => test("heartbeat")}>
                {tr("发送一次", "Ping now")}
              </Button>
            </div>
          </ChannelCard>
        </div>

        <div className="sticky bottom-0 mt-6 flex items-center justify-end gap-3 border-t border-border bg-bg py-3">
          <span className="text-xs text-muted-fg">{dirty ? tr("有未保存的修改", "Unsaved changes") : tr("已保存", "Saved")}</span>
          <Button variant="primary" disabled={!dirty} loading={busy === "save"} onClick={save}>
            {tr("保存通知设置", "Save")}
          </Button>
        </div>
      </div>
      <aside className="w-[300px] shrink-0 max-xl:hidden">
        <h2 className="mb-3 text-md font-semibold">{tr("消息预览", "Preview")}</h2>
        <div className="flex flex-col gap-3">
          {[
            { tag: tr("风控", "Risk"), cls: "bg-danger-soft text-danger", title: tr("HL 聪明钱 #1：模拟 A SOL 触发止损", "HL smart money #1: Paper A SOL stop loss"), body: tr("模拟 A SOL 止损：ROE −25.1%，市价平掉本任务份额 18.4 @ ≈229.10；等信号源平仓或反手后再跟", "Paper A SOL stop loss: ROE −25.1%, closed 18.4 @ ≈229.10; waiting for the source to close or flip") },
            { tag: tr("每日报告", "Daily report"), cls: "bg-primary-soft text-primary", title: tr("每日报告 11-21", "Daily report 11-21"), body: tr("跟单盈亏 +412.08 USDT\n运行任务 3 个，成交 46 笔，失败 0 笔，告警 1 条\n最佳：HL 聪明钱 #1 +286.20\n最差：ETH 反向 −32.10", "PnL +412.08 USDT\n3 tasks, 46 fills, 0 failed, 1 alert\nBest: HL smart money #1 +286.20\nWorst: ETH reverse −32.10") },
            { tag: tr("成交", "Fill"), cls: "bg-muted text-muted-fg", title: tr("HL 聪明钱 #1：主账户 买入 0.026 BTC @ 97812", "HL smart money #1: Main buy 0.026 BTC @ 97812"), body: tr("跟单", "Copy") },
          ].map((m) => (
            <div key={m.title} className="rounded-lg border border-border bg-card px-3 py-3 text-xs">
              <span className={clsx("inline-flex h-5 items-center px-1.5 text-[11px]", m.cls)}>{m.tag}</span>
              <div className="mt-2 text-sm font-semibold">{m.title}</div>
              <div className="mt-1 whitespace-pre-line text-muted-fg">{m.body}</div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
