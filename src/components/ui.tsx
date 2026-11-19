import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import type { Platform } from "../lib/api";
import { platformTag } from "../lib/format";
import { useTr } from "../lib/i18n";

type BtnVariant = "primary" | "outline" | "solid" | "danger" | "danger-text" | "ghost" | "link";

export function Button({ variant = "outline", size = "md", className, loading, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-[background-color,color,box-shadow,border-color] duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        size === "md" ? "h-8 px-3.5 text-sm rounded-md" : "h-7 px-2.5 text-xs rounded-md",
        {
          primary: "bg-primary text-on-primary hover:brightness-110",
          outline: "border border-border text-fg hover:bg-muted",
          solid: "bg-fg text-bg hover:opacity-90",
          danger: "border border-danger bg-danger-soft text-danger hover:bg-danger hover:text-on-danger",
          "danger-text": "text-danger hover:bg-danger-soft px-2",
          ghost: "text-fg hover:bg-muted px-2 font-normal",
          link: "h-auto px-0 text-fg underline underline-offset-4 decoration-1 hover:text-primary font-normal",
        }[variant],
        className,
      )}
    >
      {loading ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
      {children}
    </button>
  );
}

export function IconButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={clsx("inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-fg transition-colors duration-150 hover:bg-muted disabled:opacity-40", className)}>
      {children}
    </button>
  );
}

export function Seg<T extends string>({ value, onChange, options, className, size = "md" }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; disabled?: boolean }[]; className?: string; size?: "sm" | "md" }) {
  return (
    <div className={clsx("inline-flex rounded-md bg-muted p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded-[3px] transition-[background-color,color] duration-150 whitespace-nowrap disabled:opacity-40",
            size === "md" ? "h-7 px-3 text-sm" : "h-6 px-2.5 text-xs",
            value === o.value ? "bg-bg text-fg" : "text-muted-fg hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode }) {
  return (
    <label className={clsx("inline-flex items-center gap-2", disabled ? "opacity-40" : "cursor-pointer")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx("relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-200", checked ? "bg-fg" : "bg-muted border border-border")}
      >
        <span className={clsx("absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-[left,background-color] duration-200", checked ? "left-[16px] bg-bg" : "left-[2px] bg-muted-fg")} />
      </button>
      {label ? <span className="text-sm">{label}</span> : null}
    </label>
  );
}

export function Radio({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 py-1">
      <span className={clsx("mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors duration-150", checked ? "border-fg" : "border-input")} onClick={onChange}>
        {checked ? <span className="h-1.5 w-1.5 rounded-full bg-fg anim-fade" /> : null}
      </span>
      <span onClick={onChange}>
        <span className="text-sm">{label}</span>
        {hint && checked ? <span className="mt-0.5 block text-xs text-muted-fg">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <span onClick={() => onChange(!checked)} className={clsx("flex h-3.5 w-3.5 items-center justify-center border transition-colors duration-150", checked ? "border-fg bg-fg" : "border-input")}>
        {checked ? (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-bg" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2.5 6.5l2.2 2.2L9.5 3.8" />
          </svg>
        ) : null}
      </span>
      {label ? <span className="text-sm" onClick={() => onChange(!checked)}>{label}</span> : null}
    </label>
  );
}

export function Input({ className, invalid, suffix, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; suffix?: ReactNode }) {
  return (
    <div className={clsx("flex h-9 items-center rounded-md border bg-bg px-3 transition-[border-color,box-shadow] duration-150 focus-within:border-ring", invalid ? "border-danger" : "border-input", className)}>
      <input {...rest} className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-fg" />
      {suffix ? <span className="ml-2 shrink-0 text-xs text-muted-fg">{suffix}</span> : null}
    </div>
  );
}

export function NumInput({ value, onChange, suffix, className, invalid, placeholder, clearable = true }: { value: string; onChange: (v: string) => void; suffix?: ReactNode; className?: string; invalid?: boolean; placeholder?: string; clearable?: boolean }) {
  return (
    <div className={clsx("flex h-9 items-center rounded-md border bg-bg px-3 transition-[border-color] duration-150 focus-within:border-ring", invalid ? "border-danger" : "border-input", className)}>
      <input value={value} placeholder={placeholder} inputMode="decimal" onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} className="num h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-fg" />
      {suffix ? <span className="ml-2 shrink-0 text-xs text-muted-fg">{suffix}</span> : null}
      {clearable && value && !suffix ? (
        <button type="button" onClick={() => onChange("")} className="ml-2 text-muted-fg hover:text-fg">
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function Select<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  return (
    <div className={clsx("relative inline-flex h-8 items-center rounded-md border border-border hover:bg-muted", className)}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="h-full cursor-pointer appearance-none bg-transparent pl-3 pr-8 text-sm text-fg outline-none">
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-card">
            {o.label}
          </option>
        ))}
      </select>
      <svg className="pointer-events-none absolute right-2.5 h-3 w-3 text-muted-fg" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 4.5l3 3 3-3" />
      </svg>
    </div>
  );
}

export function Field({ label, children, error, hint, className }: { label?: ReactNode; children: ReactNode; error?: string | null; hint?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      {label ? <span className="text-xs text-muted-fg">{label}</span> : null}
      {children}
      {error ? <span className="text-xs text-danger">{error}</span> : hint ? <span className="text-xs text-muted-fg">{hint}</span> : null}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={clsx("flex gap-6 border-b border-border", className)}>
      {tabs.map((t) => (
        <button key={t.value} onClick={() => onChange(t.value)} className={clsx("relative pb-2.5 text-sm transition-colors duration-150", value === t.value ? "text-fg" : "text-muted-fg hover:text-fg")}>
          {t.label}
          {value === t.value ? <span className="anim-tab absolute -bottom-px left-0 right-0 h-0.5 bg-primary" /> : null}
        </button>
      ))}
    </div>
  );
}

export function Dot({ color = "success", hollow }: { color?: "success" | "warning" | "danger" | "muted"; hollow?: boolean }) {
  const c = { success: "bg-success border-success", warning: "bg-warning border-warning", danger: "bg-danger border-danger", muted: "bg-muted-fg border-muted-fg" }[color];
  return <span className={clsx("inline-block h-1.5 w-1.5 shrink-0 rounded-full border", hollow ? "border-muted-fg bg-transparent" : c)} />;
}

export function StatusLabel({ status, reconciling }: { status: "running" | "paused" | "stopped"; reconciling?: boolean }) {
  const tr = useTr();
  if (status === "running" && reconciling)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-warning">
        <Dot color="warning" />
        {tr("对账中", "Reconciling")}
      </span>
    );
  if (status === "running")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <Dot color="success" />
        {tr("运行中", "Running")}
      </span>
    );
  if (status === "paused")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-fg">
        <Dot color="muted" />
        {tr("已暂停", "Paused")}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-fg">
      <Dot hollow />
      {tr("已停止", "Stopped")}
    </span>
  );
}

export function PlatformTag({ platform, testnet }: { platform: Platform; testnet?: boolean }) {
  const tr = useTr();
  return (
    <span className="inline-flex items-center gap-1">
      <span className={clsx("inline-flex h-[18px] min-w-[28px] items-center justify-center px-1 text-[11px] leading-none", platform === "paper" ? "bg-primary-soft text-primary" : "border border-border text-muted-fg")}>
        {platform === "paper" ? tr("模拟", "Paper") : platformTag(platform)}
      </span>
      {testnet ? <span className="bg-primary-soft px-1 text-[11px] leading-[18px] text-primary">{tr("测试网", "Testnet")}</span> : null}
    </span>
  );
}

export function SideTag({ size }: { size: string | number }) {
  const tr = useTr();
  const n = Number(size);
  if (!n) return null;
  return n > 0 ? <span className="text-xs text-success">{tr("多", "L")}</span> : <span className="text-xs text-danger">{tr("空", "S")}</span>;
}

export function Modal({ open, onClose, title, children, footer, width = 440 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="anim-modal flex max-h-[85vh] max-w-[calc(100vw-24px)] flex-col rounded-lg border border-border bg-card shadow-[0_12px_32px_rgba(0,0,0,0.35)]" style={{ width }}>
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h3 className="text-xl font-semibold">{title}</h3>
          <button onClick={onClose} className="text-muted-fg hover:text-fg">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-6 pb-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-border px-6 py-4">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children, footer, width = 440 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="anim-fade fixed inset-0 z-40 bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="anim-drawer absolute top-0 right-0 bottom-0 flex max-w-full flex-col border-l border-border bg-card shadow-[0_12px_32px_rgba(0,0,0,0.35)]" style={{ width }}>
        <div className="flex items-center justify-between px-4 pt-6 pb-4 md:px-6">
          <h3 className="text-xl font-semibold">{title}</h3>
          <button onClick={onClose} className="text-muted-fg hover:text-fg">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-6 md:px-6">{children}</div>
        {footer ? <div className="flex justify-end gap-2 px-4 py-5 md:px-6">{footer}</div> : null}
      </div>
    </div>
  );
}

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
}

/** Confirmation dialog; `word` requires typing it to enable the action. */
export function Confirm({ open, onClose, onConfirm, title, body, confirmLabel, danger, word, busy }: { open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; body: ReactNode; confirmLabel: string; danger?: boolean; word?: string; busy?: boolean }) {
  const tr = useTr();
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={!!word && typed !== word} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-muted-fg">{body}</div>
      {word ? (
        <div className="mt-4">
          <Field label={tr(`输入「${word}」以确认`, `Type "${word}" to confirm`)}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}

export function Empty({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="text-md">{title}</div>
      {hint ? <div className="max-w-md text-sm text-muted-fg">{hint}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex items-center justify-between", className)}>
      <h2 className="text-md font-semibold">{children}</h2>
      {right}
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted-fg border-t-transparent" />;
}

export function Loading() {
  return (
    <div className="flex h-40 items-center justify-center">
      <Spinner />
    </div>
  );
}
