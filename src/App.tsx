import { QueryClientProvider } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { OtpCells, OtpDialog } from "./components/Otp";
import { ServerSetup } from "./components/ServerSetup";
import { BottomTabs, Sidebar, Toasts, TopBar } from "./components/Shell";
import { Button, Field, Input, Modal } from "./components/ui";
import { api, errMsg } from "./lib/api";
import { useTr } from "./lib/i18n";
import { qc, subscribeEngine, useHealth, useSettings, useTask } from "./lib/queries";
import { onServerConfig, serverConfig, ServerError } from "./lib/server";
import { applyTheme, useUi } from "./lib/store";
import { Connections } from "./pages/Connections";
import { Overview } from "./pages/Overview";
import { Compare } from "./pages/Compare";
import { Plaza } from "./pages/Plaza";
import { Records } from "./pages/Records";
import { Settings } from "./pages/Settings";
import { Sources } from "./pages/Sources";
import { TaskDetail } from "./pages/TaskDetail";
import { Tasks } from "./pages/Tasks";
import { Wizard } from "./pages/Wizard";

function Title() {
  const tr = useTr();
  const route = useUi((s) => s.route);
  const { data: t } = useTask(route.page === "task" || route.page === "wizard" ? route.id : undefined);
  switch (route.page) {
    case "overview":
      return <>{tr("总览", "Overview")}</>;
    case "tasks":
      return <>{tr("跟单任务", "Copy tasks")}</>;
    case "task":
      return (
        <>
          <span className="md:hidden">{t?.name ?? ""}</span>
          <span className="max-md:hidden">{tr("跟单任务", "Copy tasks")}</span>
        </>
      );
    case "wizard":
      if (route.convert) return <>{tr(`「${t?.name ?? ""}」转为跟单`, `Copy "${t?.name ?? ""}"`)}</>;
      return <>{route.id ? tr(`编辑「${t?.name ?? ""}」`, `Edit "${t?.name ?? ""}"`) : tr("新建跟单任务", "New copy task")}</>;
    case "sources":
      return <>{tr("信号源", "Sources")}</>;
    case "plaza":
      return (
        <>
          <span className="md:hidden">{tr("信号源", "Sources")}</span>
          <span className="max-md:hidden">{tr("跟单员广场", "Trader plaza")}</span>
        </>
      );
    case "compare":
      return <>{tr("交易员对比", "Compare traders")}</>;
    case "connections":
      return <>{tr("交易账户", "Accounts")}</>;
    case "records":
      return <>{tr("成交与盈亏", "Fills & PnL")}</>;
    case "settings":
      return (
        <>
          <span className="md:hidden">{tr("更多", "More")}</span>
          <span className="max-md:hidden">{tr("设置", "Settings")}</span>
        </>
      );
  }
}

function Page() {
  const route = useUi((s) => s.route);
  switch (route.page) {
    case "overview":
      return <Overview />;
    case "tasks":
      return <Tasks />;
    case "task":
      return <TaskDetail key={route.id} />;
    case "wizard":
      return <Wizard key={`${route.id ?? "new"}${route.convert ? ":convert" : ""}`} />;
    case "sources":
      return <Sources />;
    case "plaza":
      return <Plaza />;
    case "compare":
      return <Compare />;
    case "connections":
      return <Connections />;
    case "records":
      return <Records />;
    case "settings":
      return <Settings />;
  }
}

function LockScreen({ totp }: { totp: boolean }) {
  const tr = useTr();
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = !!pw && (!totp || (recovery ? code.trim().length >= 8 : code.length === 6));
  const submit = async (otp = code) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.unlock(pw, totp ? otp.trim() : undefined);
      setPw("");
      setCode("");
      setErr(null);
      qc.invalidateQueries();
    } catch (x) {
      setErr(errMsg(x));
      setCode("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="anim-fade fixed inset-0 z-[70] flex items-center justify-center bg-bg">
      <form
        className="flex w-[320px] flex-col items-center gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) submit();
        }}
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
          <Lock size={20} className="text-on-primary" />
        </div>
        <div className="text-lg font-semibold">{tr("界面已锁定", "Locked")}</div>
        <div className="text-center text-xs text-muted-fg">{tr("跟单任务仍在后台运行", "Copy tasks keep running in the background")}</div>
        <Input type="password" className="w-full" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus invalid={!!err} placeholder={tr("输入密码解锁", "Password")} />
        {totp ? (
          <div className="flex w-full flex-col items-center gap-2">
            <div className="self-start text-xs text-muted-fg">{tr("验证器动态码", "Authenticator code")}</div>
            {recovery ? (
              <Input className="num w-full" value={code} onChange={(e) => setCode(e.target.value)} placeholder="xxxx-xxxx" />
            ) : (
              <OtpCells value={code} onChange={setCode} onComplete={(v) => pw && submit(v)} />
            )}
            <button
              type="button"
              className="self-start text-xs text-primary hover:underline"
              onClick={() => {
                setRecovery(!recovery);
                setCode("");
              }}
            >
              {recovery ? tr("改用验证器动态码", "Use the authenticator code") : tr("换用恢复码", "Use a recovery code")}
            </button>
          </div>
        ) : null}
        {err ? <div className="text-xs text-danger">{err}</div> : null}
        <Button variant="primary" className="w-full" type="submit" loading={busy} disabled={!ready}>
          {tr("解锁", "Unlock")}
        </Button>
      </form>
    </div>
  );
}

function SecretsUnlock() {
  const tr = useTr();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={() => {}} title={tr("解锁服务器密钥文件", "Unlock server key file")} width={420}>
      <p className="mb-4 text-sm text-muted-fg">
        {tr(
          "API 密钥保存在服务器上由主密码加密的文件中（Argon2id + XChaCha20）。服务器重启后需要解锁，任务才能恢复运行；首次使用时输入的密码即为主密码，请牢记。也可在服务器设置 MERCHANDISER_MASTER_PASSWORD_FILE 自动解锁。",
          "API keys are stored on the server in a file encrypted with a master password (Argon2id + XChaCha20). After a server restart it must be unlocked before tasks resume; the first password you enter becomes the master password. The server can also unlock itself via MERCHANDISER_MASTER_PASSWORD_FILE.",
        )}
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.unlockSecrets(pw);
            qc.invalidateQueries();
          } catch (x) {
            setErr(errMsg(x));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={tr("主密码", "Master password")} error={err}>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </Field>
        <Button variant="primary" type="submit" loading={busy} disabled={pw.length < 4}>
          {tr("解锁", "Unlock")}
        </Button>
      </form>
    </Modal>
  );
}

function useServerConfig() {
  return useSyncExternalStore(
    (f) => {
      const off = onServerConfig(f);
      return () => void off();
    },
    serverConfig,
  );
}

/** Status in the tab title (replaces the desktop tray icon). */
function useTitleStatus(health: ReturnType<typeof useHealth>["data"], offline: boolean, lang: "zh" | "en") {
  useEffect(() => {
    const zh = lang !== "en";
    const running = health?.running ?? 0;
    let prefix = "";
    if (offline || !health) prefix = zh ? "⚠ 未连接 · " : "⚠ Offline · ";
    else if (health.estopped) prefix = zh ? "⛔ 急停 · " : "⛔ E-stop · ";
    else if (health.recent_errors > 0) prefix = zh ? `⚠ ${running} 运行 · ` : `⚠ ${running} running · `;
    else if (running > 0) prefix = zh ? `● ${running} 运行 · ` : `● ${running} running · `;
    document.title = `${prefix}Merchandiser`;
  }, [health, offline, lang]);
}

function Shell() {
  const tr = useTr();
  const cfg = useServerConfig();
  const { data: settings } = useSettings();
  const { data: health, error: healthErr } = useHealth();
  const { setLang, setTheme, lang } = useUi();
  const lastActive = useRef(Date.now());
  const [editServer, setEditServer] = useState(false);
  const authFailed = healthErr instanceof ServerError && healthErr.status === 401;
  const offline = !!healthErr;
  useTitleStatus(health, offline, lang);

  useEffect(() => subscribeEngine(), []);

  useEffect(() => {
    if (!settings) return;
    setLang(settings.language);
    setTheme(settings.theme);
    applyTheme(settings.theme);
    document.documentElement.lang = settings.language === "en" ? "en" : "zh-CN";
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const h = () => settings.theme === "system" && applyTheme("system");
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [settings, setLang, setTheme]);

  // Idle auto-lock.
  useEffect(() => {
    if (!settings?.app_lock || !settings.idle_lock_minutes) return;
    const bump = () => (lastActive.current = Date.now());
    window.addEventListener("mousemove", bump);
    window.addEventListener("keydown", bump);
    const t = setInterval(() => {
      if (Date.now() - lastActive.current > settings.idle_lock_minutes * 60_000) {
        api.lock().then(() => qc.invalidateQueries({ queryKey: ["health"] }));
        lastActive.current = Date.now();
      }
    }, 15_000);
    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("keydown", bump);
      clearInterval(t);
    };
  }, [settings]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar title={<Title />} />
        <div className="min-h-0 flex-1 max-md:pb-14">
          <Page />
        </div>
      </main>
      <BottomTabs />
      <Toasts />
      {health?.locked ? <LockScreen totp={!!health.totp_enabled && !health.secrets_locked} /> : null}
      <OtpDialog />
      {health?.secrets_locked && !health.locked ? <SecretsUnlock /> : null}
      {!cfg || authFailed || editServer ? (
        <ServerSetup reason={authFailed ? tr("访问令牌错误，请重新填写", "Access token rejected") : null} onClose={cfg && !authFailed ? () => setEditServer(false) : undefined} />
      ) : null}
      {cfg && offline && !authFailed && !editServer ? (
        <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-md border border-danger/50 bg-card px-4 py-2 text-sm shadow-lg">
          <span className="text-danger">{tr(`无法连接服务器 ${cfg.url || location.origin}`, `Cannot reach server ${cfg.url || location.origin}`)}</span>
          <Button size="sm" onClick={() => setEditServer(true)}>
            {tr("修改", "Change")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  );
}
