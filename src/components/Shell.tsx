import clsx from "clsx";
import { Copy, LayoutGrid, Link2, List, Lock, OctagonX, Radio as RadioIcon, SlidersHorizontal, Workflow } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { platformLabel } from "../lib/format";
import { useTr } from "../lib/i18n";
import { useAction, useHealth } from "../lib/queries";
import { useUi, type Page } from "../lib/store";
import { Dot } from "./ui";

const NAV: { page: Page; icon: typeof LayoutGrid; zh: string; en: string; match: Page[] }[] = [
  { page: "overview", icon: LayoutGrid, zh: "总览", en: "Overview", match: ["overview"] },
  { page: "tasks", icon: Copy, zh: "跟单任务", en: "Copy tasks", match: ["tasks", "task", "wizard"] },
  { page: "sources", icon: RadioIcon, zh: "信号源", en: "Sources", match: ["sources"] },
  { page: "connections", icon: Link2, zh: "连接", en: "Connections", match: ["connections"] },
  { page: "records", icon: List, zh: "记录", en: "Records", match: ["records"] },
  { page: "settings", icon: SlidersHorizontal, zh: "设置", en: "Settings", match: ["settings"] },
];

export function Sidebar() {
  const tr = useTr();
  const { route, go, toast } = useUi();
  const lock = useAction(api.lock, {});
  return (
    <aside className="flex w-[220px] shrink-0 flex-col gap-1 border-r border-border bg-card px-4 pt-6 pb-4">
      <div className="flex items-center gap-2 px-2 pb-6">
        <div className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-primary">
          <Workflow size={14} className="text-on-primary" strokeWidth={2.2} />
        </div>
        <span className="text-md font-semibold">Merchandiser</span>
      </div>
      {NAV.map((n) => {
        const active = n.match.includes(route.page);
        const Icon = n.icon;
        return (
          <button key={n.page} onClick={() => go(n.page)} className={clsx("relative flex h-9 items-center gap-3 rounded-md px-3 text-left transition-colors duration-150", active ? "bg-muted" : "hover:bg-muted")}>
            {active ? <span className="absolute top-[9px] left-0 h-[18px] w-[3px] bg-primary" /> : null}
            <Icon size={16} className="text-muted-fg" strokeWidth={1.6} />
            <span className="text-sm">{tr(n.zh, n.en)}</span>
          </button>
        );
      })}
      <div className="flex-1" />
      <button
        onClick={async () => {
          const ok = await lock.mutateAsync(undefined);
          if (!ok) toast(tr("请先在设置中开启应用锁并设置密码", "Enable the app lock in Settings first"), "info");
        }}
        className="flex items-center gap-2 px-3 py-2 text-xs text-muted-fg hover:text-fg"
      >
        <Lock size={14} strokeWidth={1.6} />
        {tr("锁定界面", "Lock")}
      </button>
      <div className="px-3 text-xs text-muted-fg">v0.1.0 {tr("本地构建", "local build")}</div>
    </aside>
  );
}

export function TopBar({ title }: { title: ReactNode }) {
  const tr = useTr();
  const lang = useUi((s) => s.lang);
  const { data: h } = useHealth();
  const estop = useAction(api.estop, { invalidate: [["health"], ["overview"]] });
  const [flash, setFlash] = useState(false);
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
      <h1 className="text-lg font-semibold">{title}</h1>
      <div className="flex items-center gap-4">
        {(h?.platforms ?? []).map((p) => {
          const stale = p.last_error_at && (!p.last_ok || p.last_error_at > p.last_ok);
          const slow = (p.latency_ms ?? 0) > 300;
          const color = stale ? "danger" : slow ? "warning" : p.last_ok ? "success" : "muted";
          return (
            <span key={p.platform} className="flex items-center gap-1.5" title={p.last_error ?? undefined}>
              <Dot color={color} />
              <span className="text-xs">{platformLabel[p.platform][lang === "en" ? 1 : 0]}</span>
              <span className={clsx("num text-xs", slow || stale ? "text-warning" : "text-muted-fg")}>{p.latency_ms != null ? `${p.latency_ms}ms` : "—"}</span>
            </span>
          );
        })}
        <span className="h-5 w-px bg-border" />
        <button
          onClick={() => {
            setFlash(true);
            estop.mutate(undefined);
            setTimeout(() => setFlash(false), 400);
          }}
          className={clsx(
            "flex h-8 items-center gap-2 rounded-md border border-danger px-3.5 text-sm font-semibold transition-[background-color,color] duration-150",
            h?.estopped || flash ? "bg-danger text-on-danger" : "bg-danger-soft text-danger hover:bg-danger hover:text-on-danger",
          )}
          title={tr("立即暂停全部任务并撤销镜像挂单，不平仓", "Pause every task and cancel mirrored orders; positions stay")}
        >
          <OctagonX size={14} />
          {h?.estopped ? tr("已急停", "E-stopped") : tr("全局急停", "E-stop")}
        </button>
      </div>
    </header>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useUi();
  return (
    <div className="pointer-events-none fixed right-6 bottom-6 z-[60] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={clsx(
            "anim-rise pointer-events-auto max-w-sm cursor-pointer rounded-md border px-4 py-3 text-sm shadow-[0_12px_32px_rgba(0,0,0,0.3)]",
            t.kind === "error" ? "border-danger bg-danger-soft text-danger" : t.kind === "info" ? "border-border bg-card" : "border-border bg-card",
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** The motif: source / target / actual on one axis; the gap is highlighted. */
export function DeviationBar({ src, target, actual, width = 130 }: { src: number; target: number; actual: number; width?: number }) {
  const max = Math.max(src, target, actual, 1e-9);
  // Source is scaled to the target so the three share one axis.
  const s = target > 0 ? target / max : src > 0 ? 1 : 0;
  const t = target / max;
  const a = actual / max;
  const lo = Math.min(t, a);
  const hi = Math.max(t, a);
  return (
    <div className="flex flex-col gap-[2px]" style={{ width }}>
      <div className="h-[3px] bg-muted">
        <div className="h-full bg-[var(--bar-src)]" style={{ width: `${s * 100}%` }} />
      </div>
      <div className="h-[3px] bg-muted">
        <div className="h-full bg-[var(--bar-tgt)]" style={{ width: `${t * 100}%` }} />
      </div>
      <div className="relative h-[3px] bg-muted">
        <div className="h-full bg-[var(--bar-act)]" style={{ width: `${lo * 100}%` }} />
        {hi - lo > 0.005 ? <div className="absolute top-0 h-full bg-primary" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} /> : null}
      </div>
    </div>
  );
}

export function Legend() {
  const tr = useTr();
  const item = (c: string, l: string) => (
    <span className="flex items-center gap-1.5 text-xs text-muted-fg">
      <span className="h-[3px] w-2.5" style={{ background: c }} />
      {l}
    </span>
  );
  return (
    <div className="flex items-center gap-3">
      {item("var(--bar-src)", tr("信号源", "Source"))}
      {item("var(--bar-tgt)", tr("目标", "Target"))}
      {item("var(--bar-act)", tr("实际", "Actual"))}
      {item("var(--primary)", tr("偏差", "Gap"))}
    </div>
  );
}
