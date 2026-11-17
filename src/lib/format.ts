import type { Platform } from "./api";

const MINUS = "−";

function parts(v: number, dp: number) {
  return Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** 1234.5 → "1,234.50"; negatives use a true minus sign. */
export function num(v: string | number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return (n < 0 ? MINUS : "") + parts(n, dp);
}

/** Signed: "+1,284.30" / "−213.40". */
export function signed(v: string | number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return parts(0, dp);
  return (n > 0 ? "+" : MINUS) + parts(n, dp);
}

/** Quantity: keep meaningful precision without trailing noise. */
export function qty(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const dp = a === 0 ? 0 : a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
  return num(n, dp);
}

/** Price with adaptive precision. */
export function price(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return "—";
  const a = Math.abs(n);
  const dp = a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return num(n, dp);
}

export function pnlClass(v: string | number | null | undefined) {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n === 0) return "text-fg";
  return n > 0 ? "text-success" : "text-danger";
}

export function time(ts: number, ms = false) {
  const d = new Date(ts);
  const p = (x: number, l = 2) => String(x).padStart(l, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${ms ? "." + p(d.getMilliseconds(), 3) : ""}`;
}

export function date(ts: number) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ago(ts: number | null | undefined, en = false) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return en ? `${s}s ago` : `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return en ? `${m}m ago` : `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 48) return en ? `${h}h ago` : `${h} 小时前`;
  return en ? `${Math.round(h / 24)}d ago` : `${Math.round(h / 24)} 天前`;
}

export function days(from: number | null | undefined) {
  if (!from) return 0;
  return Math.max(0, Math.floor((Date.now() - from) / 86_400_000));
}

export function shortAddr(a: string | null | undefined) {
  if (!a) return "";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export const platformLabel: Record<Platform, [string, string]> = {
  okx: ["OKX", "OKX"],
  binance: ["币安", "Binance"],
  gate: ["Gate", "Gate"],
  hyperliquid: ["Hyperliquid", "Hyperliquid"],
  paper: ["模拟", "Paper"],
};

export const platformTag: Record<Platform, string> = {
  okx: "OKX",
  binance: "BN",
  gate: "Gate",
  hyperliquid: "HL",
  paper: "模拟",
};
