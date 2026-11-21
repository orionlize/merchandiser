// HTTP transport to the Go server: POST /api/{command} and an SSE event stream.
// The server address and access token are stored per device.

const KEY = "merchandiser.server";
/** Empty = the site this page was served from (the Go server, or the Vite dev proxy). */
export const DEFAULT_URL = "";

export interface ServerConfig {
  url: string;
  token: string;
}

function read(): ServerConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as ServerConfig;
    return c.token ? c : null;
  } catch {
    return null;
  }
}

let config: ServerConfig | null = read();
const listeners = new Set<() => void>();

export function serverConfig(): ServerConfig | null {
  return config;
}

export function setServerConfig(c: ServerConfig | null) {
  config = c ? { url: c.url.trim().replace(/\/+$/, ""), token: c.token.trim() } : null;
  try {
    if (config) localStorage.setItem(KEY, JSON.stringify(config));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: keep in memory */
  }
  listeners.forEach((f) => f());
}

export function onServerConfig(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

export class ServerError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Machine-readable error code (e.g. otp_required). */
    public code?: string,
  ) {
    super(message);
  }
}

export interface OtpRequest {
  /** The command that needs the code. */
  cmd: string;
  /** Why the last code was refused (null on the first ask). */
  error: string | null;
}

/** Asks the user for a two-step code; resolves null when cancelled. Installed by the OTP dialog. */
let otpPrompt: ((r: OtpRequest) => Promise<string | null>) | null = null;
export function setOtpPrompt(f: typeof otpPrompt) {
  otpPrompt = f;
}

// A verified code earns a ticket that skips the prompt for a few minutes.
let graceTicket: string | null = null;

const OTP_CODES = new Set(["otp_required", "otp_invalid", "otp_locked"]);

/**
 * Calls one server command; rejects with the server's error message. A
 * sensitive command that needs a two-step code asks for it (through the OTP
 * dialog) and is retried.
 */
export async function call<T>(cmd: string, args: Record<string, unknown> = {}, cfg: ServerConfig | null = config): Promise<T> {
  if (!cfg) throw new ServerError("未配置服务器地址", 0);
  let otp: string | null = null;
  for (;;) {
    let res: Response;
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` };
    if (otp) headers["X-OTP"] = otp;
    if (graceTicket) headers["X-OTP-Grace"] = graceTicket;
    try {
      res = await fetch(`${cfg.url}/api/${cmd}`, { method: "POST", headers, body: JSON.stringify(args) });
    } catch (e) {
      throw new ServerError(`无法连接服务器 ${cfg.url}：${e instanceof Error ? e.message : String(e)}`, 0);
    }
    const ticket = res.headers.get("X-OTP-Grace");
    if (ticket) graceTicket = ticket;
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.ok) return body as T;
    const obj = body && typeof body === "object" ? (body as { error?: unknown; code?: unknown }) : null;
    const msg = obj && "error" in obj ? String(obj.error) : `HTTP ${res.status}`;
    const code = obj && typeof obj.code === "string" ? obj.code : undefined;
    // The lock screen asks for its own code inline.
    if (code && OTP_CODES.has(code) && otpPrompt && cmd !== "unlock_app") {
      const next = await otpPrompt({ cmd, error: code === "otp_required" ? null : msg });
      if (next == null) throw new ServerError("已取消两步验证", 403, "otp_cancelled");
      otp = next;
      continue;
    }
    throw new ServerError(msg, res.status, code);
  }
}

export type EngineEvent = { kind: "changed"; scope: string } | { kind: "alert"; level: string; title: string; detail?: string | null };

/**
 * Subscribes to the server's SSE stream (fetch-based so the token can go in
 * a header). Reconnects with backoff; `onOpen` fires after each (re)connect
 * so callers can refetch whatever they may have missed.
 */
export function subscribe(onEvent: (e: EngineEvent) => void, onOpen?: () => void): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;
  let delay = 1000;

  const loop = async () => {
    while (!stopped) {
      const cfg = config;
      if (!cfg) {
        await sleep(1000);
        continue;
      }
      ctrl = new AbortController();
      try {
        const res = await fetch(`${cfg.url}/api/events`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: "text/event-stream" }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        delay = 1000;
        onOpen?.();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            try {
              onEvent(JSON.parse(data) as EngineEvent);
            } catch {
              /* ignore malformed event */
            }
          }
        }
      } catch {
        /* network error or abort: retry below */
      }
      if (stopped) break;
      await sleep(delay);
      delay = Math.min(delay * 2, 15000);
    }
  };
  loop();
  const off = onServerConfig(() => ctrl?.abort());
  return () => {
    stopped = true;
    off();
    ctrl?.abort();
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
