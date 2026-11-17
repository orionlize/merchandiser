import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ServerSetup } from "../components/ServerSetup";
import { Button, Dot, Field, Input, Loading, Modal, Seg, Select, Toggle } from "../components/ui";
import { api, errMsg, type Platform, type Settings as S, type SymbolRow } from "../lib/api";
import { time } from "../lib/format";
import { useTr } from "../lib/i18n";
import { qc, useHealth, useSettings } from "../lib/queries";
import { downloadText, pickTextFile } from "../lib/files";
import { serverConfig } from "../lib/server";
import { applyTheme, useUi } from "../lib/store";

export function Settings() {
  const tr = useTr();
  const [sub, setSub] = useState<"general" | "symbols" | "notify">("general");
  const items = [
    { v: "general" as const, l: tr("通用与安全", "General & security") },
    { v: "symbols" as const, l: tr("品种映射", "Symbol map") },
    { v: "notify" as const, l: tr("通知与心跳", "Notifications") },
  ];
  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-[170px] shrink-0 flex-col gap-1 px-4 py-6">
        {items.map((i) => (
          <button key={i.v} onClick={() => setSub(i.v)} className={clsx("h-9 rounded-md px-3 text-left text-sm transition-colors duration-150", sub === i.v ? "bg-muted text-fg" : "text-muted-fg hover:text-fg")}>
            {i.l}
          </button>
        ))}
      </nav>
      <div key={sub} className="anim-fade min-w-0 flex-1 overflow-y-auto px-6 py-6">
        {sub === "general" ? <General /> : sub === "symbols" ? <Symbols /> : <Notify />}
      </div>
    </div>
  );
}

function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-6 border-b border-border py-3">
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
      <Row
        title={tr("密钥存储", "Key storage")}
        hint={tr("密钥只保存在服务器上，由主密码加密（Argon2id）；客户端永远拿不到明文", "Keys live only on the server, encrypted with a master password (Argon2id); the client never sees plaintext")}
      >
        <span className="flex items-center gap-1.5 text-xs">
          <Dot color={h?.secrets_locked ? "warning" : "success"} />
          {h?.secrets_locked ? tr("未解锁", "Locked") : tr("正常", "OK")}
        </span>
      </Row>

      <h2 className="mt-8 mb-1 text-md font-semibold">{tr("数据", "Data")}</h2>
      <Row title={tr("执行日志保留", "Keep logs for")}>
        <Select value={String(s.log_retention_days)} onChange={(v) => set({ log_retention_days: Number(v) })} options={[30, 90, 180, 365].map((d) => ({ value: String(d), label: tr(`${d} 天`, `${d} days`) }))} />
      </Row>
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

const PLATS: Platform[] = ["okx", "binance", "gate", "hyperliquid"];

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
    if (p === "okx" || p === "gate") suffix = cpu !== 1 ? ` × ${fmtMult(cpu)}` : "";
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
        {tr("启动时从各平台拉取合约列表自动生成，内部统一用币的数量。点击单元格可手动修正。", "Built from each venue's contract list; quantities are normalised to coins internally. Click a cell to correct it.")}
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
                <th className="px-2 font-normal">{tr("OKX（面值）", "OKX (ct val)")}</th>
                <th className="px-2 font-normal">{tr("币安", "Binance")}</th>
                <th className="px-2 font-normal">{tr("Gate（乘数）", "Gate (mult)")}</th>
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

function Notify() {
  const tr = useTr();
  const { data: s } = useSettings();
  const saveS = useSaveSettings();
  if (!s) return <Loading />;
  return (
    <div className="max-w-[560px]">
      <h2 className="mb-1 text-md font-semibold">{tr("通知", "Notifications")}</h2>
      <Row title={tr("浏览器通知", "Browser notifications")} hint={tr("下单失败、风控触发、断线、急停时弹出通知（需页面打开，HTTPS 或 localhost 下可用）", "Failed orders, risk triggers, disconnects and e-stops (page must be open; HTTPS or localhost)")}>
        <Toggle checked={s.notifications} onChange={(v) => saveS({ ...s, notifications: v })} />
      </Row>
      <div className="mt-8 rounded-lg border border-border px-4 py-4">
        <div className="text-sm">{tr("Telegram Bot、Webhook 与心跳外发将在第二期上线", "Telegram, webhook and outbound heartbeat arrive in phase 2")}</div>
        <div className="mt-1 text-xs text-muted-fg">{tr("当前仅使用浏览器通知", "For now only browser notifications are used")}</div>
      </div>
    </div>
  );
}
