import { useState } from "react";
import { errMsg, type Health } from "../lib/api";
import { useTr } from "../lib/i18n";
import { qc } from "../lib/queries";
import { call, DEFAULT_URL, serverConfig, setServerConfig } from "../lib/server";
import { Button, Field, Input, Modal } from "./ui";

/** Server address + access token. Shown on first run, on auth / network failure, and from Settings. */
export function ServerSetup({ reason, onClose }: { reason?: string | null; onClose?: () => void }) {
  const tr = useTr();
  const cur = serverConfig();
  const [url, setUrl] = useState(cur?.url ?? DEFAULT_URL);
  const [token, setToken] = useState(cur?.token ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const cfg = { url: url.trim().replace(/\/+$/, ""), token: token.trim() };
    try {
      await call<Health>("get_health", {}, cfg);
      setServerConfig(cfg);
      qc.invalidateQueries();
      onClose?.();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={() => onClose?.()} title={tr("连接跟单服务器", "Connect to server")} width={460}>
      <p className="mb-4 text-sm text-muted-fg">
        {tr(
          "带单、任务、密钥与监控都运行在服务器上，本页面只负责展示和操作。访问令牌见服务器环境变量 MERCHANDISER_TOKEN，或数据目录下的 api_token 文件（首次启动时也会打印在日志里）。",
          "Copying, tasks, keys and monitoring run on the server; this page only displays and controls them. The access token is the server's MERCHANDISER_TOKEN, or the api_token file in its data directory (also printed in the log on first start).",
        )}
      </p>
      {reason ? <div className="mb-3 rounded-md border border-danger/40 px-3 py-2 text-xs text-danger">{reason}</div> : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={tr("服务器地址", "Server URL")} hint={tr("留空表示当前站点", "Leave empty for this site")}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={location.origin} />
        </Field>
        <Field label={tr("访问令牌", "Access token")} error={err}>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
        </Field>
        <div className="text-xs text-muted-fg">{tr("远程访问请在服务器前加 HTTPS 反向代理，不要把明文 HTTP 端口暴露到公网。", "For remote access put an HTTPS reverse proxy in front; never expose the plain HTTP port publicly.")}</div>
        <Button variant="primary" type="submit" loading={busy} disabled={!token.trim()}>
          {tr("连接", "Connect")}
        </Button>
      </form>
    </Modal>
  );
}
