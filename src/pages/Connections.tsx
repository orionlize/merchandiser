import clsx from "clsx";
import { AlertTriangle, Check, Info, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Confirm, Drawer, Empty, Field, Input, Loading, Seg, Toggle } from "../components/ui";
import { api, errMsg, type Connection, type ConnectionInput, type Platform, type Validation } from "../lib/api";
import { num, platformLabel, pnlClass, signed } from "../lib/format";
import { useTr } from "../lib/i18n";
import { qc, useAction, useConnections } from "../lib/queries";
import { useUi } from "../lib/store";

export function Connections() {
  const tr = useTr();
  const lang = useUi((s) => s.lang);
  const { data, isLoading } = useConnections();
  const [drawer, setDrawer] = useState<{ open: boolean; edit?: Connection }>({ open: false });
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const test = useAction(api.testConnection, { ok: (v) => (v.ok ? tr("校验通过", "Check passed") : tr("校验有问题，请查看", "Check reported issues")), invalidate: [["connections"]] });
  const del = useAction(api.deleteConnection, { ok: tr("已删除", "Deleted"), invalidate: [["connections"]] });

  if (isLoading) return <Loading />;
  const conns = data ?? [];
  const withdraw = conns.filter((c) => c.perms?.withdraw);

  const permLabel = (c: Connection) => {
    if (c.platform === "paper") return tr("模拟（不发真实订单）", "Paper (no real orders)");
    if (c.platform === "hyperliquid") return tr("API 钱包签名（不可提款）", "API wallet (cannot withdraw)");
    if (!c.perms) return "—";
    const base = c.perms.trade ? tr("合约交易", "Futures trade") : tr("只读", "Read-only");
    return c.perms.withdraw ? `${base} + ${tr("提币", "withdraw")}` : base;
  };
  const role = (c: Connection) => {
    const env = c.platform === "paper" ? "" : c.testnet ? tr("测试网", "testnet") : tr("实盘", "live");
    const parts = [platformLabel[c.platform][lang === "en" ? 1 : 0] + (env ? ` ${env}` : "")];
    if (c.source_count) parts.push(tr("信号源", "source"));
    if (c.proxy) parts.push(c.proxy.startsWith("socks") ? tr("代理 SOCKS5", "SOCKS5 proxy") : tr("代理 HTTP", "HTTP proxy"));
    return parts.join(tr("，", ", "));
  };

  const live = conns.filter((c) => c.platform !== "paper" && !c.testnet && c.equity != null);
  const equity = live.reduce((a, c) => a + Number(c.equity), 0);
  const avail = live.reduce((a, c) => a + Number(c.available ?? 0), 0);
  const today = live.reduce((a, c) => a + Number(c.today_pnl ?? 0), 0);
  const used = equity > 0 ? Math.min(1, Math.max(0, (equity - avail) / equity)) : 0;
  const issues = (c: Connection) => (c.perms?.withdraw ? 1 : 0) + (c.one_way === false ? 1 : 0);

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 py-4 md:px-6 md:py-6">
      {live.length ? (
        <div className="mb-4 border border-border bg-card px-4 py-4 max-md:-mx-4 max-md:border-x-0 md:px-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-xs text-muted-fg">{tr("实盘总权益（USDT）", "Live equity (USDT)")}</div>
              <div className="num mt-1 text-[32px] leading-tight font-semibold tracking-[-0.5px]">{num(equity)}</div>
            </div>
            <div className="flex gap-8">
              <div>
                <div className="text-xs text-muted-fg">{tr("今日", "Today")}</div>
                <div className={clsx("num mt-1 text-lg", pnlClass(today))}>{signed(today)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-fg">{tr("可用保证金", "Available")}</div>
                <div className="num mt-1 text-lg">{num(avail)}</div>
              </div>
            </div>
          </div>
          <div className="mt-4 flex h-1.5 bg-muted">
            <div className="h-full bg-primary" style={{ width: `${used * 100}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-xs text-muted-fg">
            <span>{tr("保证金占用", "Margin in use")}</span>
            <span className="num">{num(used * 100, 1)}%</span>
          </div>
        </div>
      ) : null}
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-fg">{tr(`${conns.length} 个连接，密钥加密保存在服务器上，只在服务端进程内解密`, `${conns.length} connections. Keys are stored encrypted on the server and only decrypted inside the server process.`)}</span>
        <Button variant="primary" onClick={() => setDrawer({ open: true })}>
          <Plus size={14} />
          {tr("添加账户", "Add account")}
        </Button>
      </div>
      {conns.length === 0 ? (
        <div className="rounded-lg border border-border">
          <Empty
            title={tr("还没有连接", "No connections")}
            hint={tr("添加 OKX、币安、Gate 的 API Key，Hyperliquid 的 API 钱包，或一个模拟账户先试跑。", "Add an OKX / Binance / Gate API key, a Hyperliquid API wallet, or a paper account to try things out.")}
          />
        </div>
      ) : (
        <>
        <div className="flex flex-col gap-3 md:hidden">
          {conns.map((c) => (
            <div key={c.id} className={clsx("border bg-card", issues(c) ? "border-warning" : "border-border")}>
              <div className="flex items-start justify-between gap-3 px-4 pt-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{c.alias}</span>
                    {c.platform === "paper" ? <span className="bg-primary-soft px-1 text-[11px] text-primary">{tr("模拟", "Paper")}</span> : c.testnet ? <span className="bg-primary-soft px-1 text-[11px] text-primary">{tr("测试网", "Testnet")}</span> : null}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-fg">{role(c)}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="num">{num(c.equity)}</div>
                  <div className={clsx("num text-xs", pnlClass(c.today_pnl))}>{signed(c.today_pnl)}</div>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 px-4 pb-1 text-xs">
                <span className={clsx("truncate", c.perms?.withdraw ? "text-danger" : "text-muted-fg")}>
                  {permLabel(c)}
                  {c.one_way === false ? <span className="text-warning">{tr("，双向持仓", ", hedge mode")}</span> : null}
                </span>
                <span className={clsx("num shrink-0", (c.latency_ms ?? 0) > 300 ? "text-warning" : "text-muted-fg")}>{c.platform !== "paper" && c.latency_ms != null ? `${c.latency_ms} ms` : ""}</span>
              </div>
              <div className="flex justify-end border-t border-border px-2 py-1">
                <Button variant="ghost" size="sm" loading={test.isPending && test.variables === c.id} onClick={() => test.mutate(c.id)}>
                  {tr("测试", "Test")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDrawer({ open: true, edit: c })}>
                  {tr("编辑", "Edit")}
                </Button>
                <Button variant="ghost" size="sm" className="text-muted-fg hover:text-danger" onClick={() => setDeleting(c)}>
                  {tr("删除", "Delete")}
                </Button>
              </div>
            </div>
          ))}
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card max-md:hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-fg">
                <th className="px-4 py-2.5 font-normal">{tr("连接", "Connection")}</th>
                <th className="px-2 font-normal">{tr("权限", "Permissions")}</th>
                <th className="px-2 font-normal">{tr("持仓模式", "Mode")}</th>
                <th className="px-2 text-right font-normal">{tr("权益", "Equity")}</th>
                <th className="px-2 text-right font-normal">{tr("可用保证金", "Available")}</th>
                <th className="px-2 text-right font-normal">{tr("延迟", "Latency")}</th>
                <th className="px-4 text-right font-normal">{tr("操作", "Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {conns.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{c.alias}</span>
                      {c.testnet ? <span className="bg-primary-soft px-1 text-[11px] text-primary">{tr("测试网", "Testnet")}</span> : null}
                      {c.platform === "paper" ? <span className="bg-primary-soft px-1 text-[11px] text-primary">{tr("模拟", "Paper")}</span> : null}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-fg">{role(c)}</div>
                  </td>
                  <td className={clsx("px-2", c.perms?.withdraw && "text-danger")}>
                    {c.perms?.withdraw ? <AlertTriangle size={12} className="mr-1 inline" /> : null}
                    {permLabel(c)}
                  </td>
                  <td className={clsx("px-2", c.one_way === false && "text-warning")}>
                    {c.one_way === false ? tr("双向", "Hedge") : c.one_way ? tr("单向", "One-way") : "—"}
                    {c.margin_mode ? <span className="text-muted-fg">，{c.margin_mode}</span> : null}
                  </td>
                  <td className="num px-2 text-right">{num(c.equity)}</td>
                  <td className="num px-2 text-right">{c.perms?.trade || c.platform === "paper" ? num(c.available) : "—"}</td>
                  <td className={clsx("num px-2 text-right", (c.latency_ms ?? 0) > 300 && "text-warning")}>{c.platform === "paper" ? "—" : c.latency_ms != null ? `${c.latency_ms} ms` : "—"}</td>
                  <td className="px-4 text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" loading={test.isPending && test.variables === c.id} onClick={() => test.mutate(c.id)}>
                      {tr("测试", "Test")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDrawer({ open: true, edit: c })}>
                      {tr("编辑", "Edit")}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-muted-fg hover:text-danger" onClick={() => setDeleting(c)}>
                      {tr("删除", "Delete")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      {withdraw.map((c) => (
        <div key={c.id} className="mt-4 flex items-center gap-2 rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
          <AlertTriangle size={14} />
          {tr(`${c.alias} 开启了提币权限。跟单只需合约交易权限，请到交易所关闭提币并绑定 IP 白名单。`, `${c.alias} has withdrawal permission. Copying only needs futures trading — disable withdrawals and bind an IP allow-list.`)}
        </div>
      ))}
      <ConnectionDrawer open={drawer.open} edit={drawer.edit} onClose={() => setDrawer({ open: false })} />
      <Confirm
        open={!!deleting}
        onClose={() => setDeleting(null)}
        danger
        title={tr("删除连接", "Delete connection")}
        body={tr(`删除「${deleting?.alias}」并从服务器移除其密钥？被任务或信号源使用时无法删除。`, `Delete "${deleting?.alias}" and remove its keys from the server? Connections in use cannot be deleted.`)}
        confirmLabel={tr("删除", "Delete")}
        busy={del.isPending}
        onConfirm={async () => {
          await del.mutateAsync(deleting!.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}

const EMPTY: ConnectionInput = { platform: "okx", alias: "", testnet: false, api_key: "", secret: "", passphrase: "", proxy: "", paper_initial: "10000" };

function ConnectionDrawer({ open, edit, onClose }: { open: boolean; edit?: Connection; onClose: () => void }) {
  const tr = useTr();
  const toast = useUi((s) => s.toast);
  const [f, setF] = useState<ConnectionInput>(EMPTY);
  const [v, setV] = useState<Validation | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showProxy, setShowProxy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setV(null);
    if (edit) {
      setF({ id: edit.id, platform: edit.platform, alias: edit.alias, testnet: edit.testnet, api_key: "", secret: "", passphrase: "", proxy: edit.proxy ?? "", paper_initial: null });
      setShowProxy(!!edit.proxy);
    } else {
      setF(EMPTY);
      setShowProxy(false);
    }
  }, [open, edit]);

  const set = (p: Partial<ConnectionInput>) => {
    setF((x) => ({ ...x, ...p }));
    setV(null);
  };
  const isHl = f.platform === "hyperliquid";
  const isPaper = f.platform === "paper";
  const needSecrets = !edit || !!f.secret;
  const complete = f.alias.trim() && (isPaper || !needSecrets || (f.api_key.trim() && f.secret.trim() && (f.platform !== "okx" || f.passphrase?.trim())));

  const runCheck = async () => {
    setChecking(true);
    try {
      setV(await api.validateConnection(f));
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const force = !!v && v.checks.some((c) => c.level === "error" && c.text.includes("提币"));
      await api.saveConnection(f, force);
      toast(tr("连接已保存", "Connection saved"));
      qc.invalidateQueries({ queryKey: ["connections"] });
      onClose();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const switchOneWay = async () => {
    try {
      await api.switchOneWay(edit?.id ?? null, edit ? undefined : f);
      toast(tr("已切换为单向持仓", "Switched to one-way mode"));
      runCheck();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const platforms: { value: Platform; label: string }[] = [
    { value: "okx", label: "OKX" },
    { value: "binance", label: tr("币安", "Binance") },
    { value: "gate", label: "Gate" },
    { value: "hyperliquid", label: "Hyperliquid" },
    { value: "paper", label: tr("模拟", "Paper") },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={edit ? tr("编辑连接", "Edit connection") : tr("添加连接", "Add connection")}
      width={460}
      footer={
        <>
          <Button disabled={!complete} loading={checking} onClick={runCheck}>
            {v ? tr("重新校验", "Re-check") : tr("校验", "Check")}
          </Button>
          <Button variant="solid" disabled={!complete || !v || v.checks.some((c) => c.level === "error" && !c.text.includes("提币"))} loading={saving} onClick={save}>
            {tr("保存连接", "Save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label={tr("平台", "Venue")}>
          {edit ? (
            <div className="text-sm">{platforms.find((p) => p.value === f.platform)?.label}</div>
          ) : (
            <Seg className="w-full [&>button]:flex-1" value={f.platform} onChange={(p) => set({ platform: p, testnet: false })} options={platforms} />
          )}
        </Field>
        <div className="flex gap-4">
          <Field label={tr("别名", "Alias")} className="flex-1">
            <Input value={f.alias} onChange={(e) => set({ alias: e.target.value })} placeholder={tr("如：okx-follow-02", "e.g. okx-follow-02")} />
          </Field>
          {!isPaper ? (
            <Field label={tr("环境", "Environment")}>
              <div className="flex h-9 items-center">
                <Toggle checked={f.testnet} onChange={(t) => set({ testnet: t })} label={f.platform === "okx" ? tr("模拟盘", "Demo") : tr("测试网", "Testnet")} />
              </div>
            </Field>
          ) : null}
        </div>
        {isPaper ? (
          <Field label={tr("初始资金", "Starting balance")} hint={tr("用 Hyperliquid 实时行情虚拟撮合，不发真实订单。", "Virtual fills on live Hyperliquid prices; no real orders.")}>
            <Input value={f.paper_initial ?? ""} onChange={(e) => set({ paper_initial: e.target.value.replace(/[^0-9.]/g, "") })} suffix="USDT" />
          </Field>
        ) : isHl ? (
          <>
            <Field label={tr("主账户地址", "Main account address")}>
              <Input className="num" value={f.api_key} onChange={(e) => set({ api_key: e.target.value.trim() })} placeholder={edit ? tr("留空则不修改", "Leave empty to keep") : "0x…"} />
            </Field>
            <Field label={tr("API 钱包私钥", "API wallet private key")}>
              <Input type="password" className="num" value={f.secret} onChange={(e) => set({ secret: e.target.value.trim() })} placeholder={edit ? tr("留空则不修改", "Leave empty to keep") : "0x…"} />
            </Field>
            <div className="flex gap-2 rounded-md bg-primary-soft px-3 py-2.5 text-xs">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
              <span>{tr("只填写在 Hyperliquid「API」页创建的 API 钱包私钥，它无法提款。不要输入主钱包私钥。", "Only enter an API wallet key created on Hyperliquid's API page — it cannot withdraw. Never enter your main wallet key.")}</span>
            </div>
          </>
        ) : (
          <>
            <Field label="API Key">
              <Input className="num" value={f.api_key} onChange={(e) => set({ api_key: e.target.value.trim() })} placeholder={edit ? tr("留空则不修改", "Leave empty to keep") : ""} />
            </Field>
            <Field label={f.platform === "binance" ? tr("Secret / 私钥", "Secret / private key") : "Secret"}>
              <Input type="password" className="num" value={f.secret} onChange={(e) => set({ secret: e.target.value.trim() })} placeholder={edit ? tr("留空则不修改", "Leave empty to keep") : f.platform === "binance" ? tr("系统生成 Key 填 Secret；Ed25519 / RSA Key 填私钥", "Secret for system keys; private key for Ed25519 / RSA") : ""} />
            </Field>
            {f.platform === "okx" ? (
              <Field label="Passphrase">
                <Input type="password" value={f.passphrase ?? ""} onChange={(e) => set({ passphrase: e.target.value })} placeholder={edit ? tr("留空则不修改", "Leave empty to keep") : ""} />
              </Field>
            ) : null}
          </>
        )}
        {!isPaper ? (
          showProxy ? (
            <Field label={tr("代理", "Proxy")} hint={tr("如 socks5://127.0.0.1:1080 或 http://127.0.0.1:7890", "e.g. socks5://127.0.0.1:1080 or http://127.0.0.1:7890")}>
              <Input className="num" value={f.proxy ?? ""} onChange={(e) => set({ proxy: e.target.value.trim() })} />
            </Field>
          ) : (
            <Button variant="link" className="self-start text-xs" onClick={() => setShowProxy(true)}>
              {tr("配置代理", "Configure proxy")}
            </Button>
          )
        ) : null}
        {v ? (
          <div className="anim-rise border-t border-border pt-5">
            <h4 className="mb-3 text-sm font-semibold">{tr("校验结果", "Check results")}</h4>
            <div className="flex flex-col gap-2.5">
              {v.checks.map((c, i) => (
                <div key={i} className={clsx("flex items-start gap-2 text-xs", c.level === "error" ? "text-danger" : c.level === "warn" ? "text-warning" : "")}>
                  {c.level === "ok" ? <Check size={13} className="mt-0.5 shrink-0 text-success" /> : c.level === "error" ? <X size={13} className="mt-0.5 shrink-0" /> : c.level === "warn" ? <AlertTriangle size={13} className="mt-0.5 shrink-0" /> : <Info size={13} className="mt-0.5 shrink-0 text-muted-fg" />}
                  <span className="flex-1">{c.text}</span>
                  {c.action === "switch_one_way" ? (
                    <Button variant="link" className="text-xs" onClick={switchOneWay}>
                      {tr("一键切换", "Switch")}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            {v.info ? (
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <span className="text-muted-fg">{tr("权益", "Equity")}</span>
                <span className="num text-right">
                  {num(v.info.equity)} {v.info.margin_asset}
                </span>
                <span className="text-muted-fg">{tr("可用保证金", "Available")}</span>
                <span className="num text-right">{num(v.info.available)}</span>
              </div>
            ) : null}
            {v.checks.some((c) => c.level === "error" && c.text.includes("提币")) ? <p className="mt-3 text-xs text-danger">{tr("仍可保存，但强烈建议先关闭提币权限。", "You can still save, but disable withdrawals first.")}</p> : null}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
