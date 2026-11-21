import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useTr } from "../lib/i18n";
import { opLabel } from "../lib/ops";
import { setOtpPrompt, type OtpRequest } from "../lib/server";
import { useUi } from "../lib/store";
import { Button, Input } from "./ui";

/** Six digit cells over one real input (paste and autofill work). */
export function OtpCells({ value, onChange, onComplete, autoFocus, invalid, disabled }: { value: string; onChange: (v: string) => void; onComplete?: (v: string) => void; autoFocus?: boolean; invalid?: boolean; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const digits = value.padEnd(6).slice(0, 6).split("");
  const active = Math.min(value.length, 5);
  return (
    <div className="relative flex gap-2" onClick={() => ref.current?.focus()}>
      {digits.map((d, i) => (
        <div
          key={i}
          className={clsx(
            "num flex h-11 w-10 items-center justify-center rounded-md border bg-bg text-lg transition-colors duration-150",
            invalid ? "border-danger" : focus && i === active ? "border-primary" : "border-input",
          )}
        >
          {d.trim()}
        </div>
      ))}
      <input
        ref={ref}
        value={value}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="one-time code"
        maxLength={6}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 6);
          onChange(v);
          if (v.length === 6) onComplete?.(v);
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </div>
  );
}

/** Asks for the two-step code whenever a command needs one (installed once in the shell). */
export function OtpDialog() {
  const tr = useTr();
  const en = useUi((s) => s.lang) === "en";
  const [req, setReq] = useState<OtpRequest | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const resolver = useRef<((v: string | null) => void) | null>(null);

  useEffect(() => {
    setOtpPrompt(
      (r) =>
        new Promise<string | null>((resolve) => {
          resolver.current?.(null);
          resolver.current = resolve;
          setCode("");
          setReq(r);
        }),
    );
    return () => setOtpPrompt(null);
  }, []);

  const finish = (v: string | null) => {
    resolver.current?.(v);
    resolver.current = null;
    setReq(null);
    setCode("");
    setRecovery(false);
  };

  if (!req) return null;
  const submit = (v = code) => {
    if (recovery ? v.trim().length >= 8 : v.length === 6) finish(v.trim());
  };
  return (
    <div className="anim-fade fixed inset-0 z-[80] flex items-center justify-center bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <form
        className="anim-modal w-[340px] max-w-[calc(100vw-24px)] rounded-lg border border-border bg-card p-6 shadow-[0_12px_32px_rgba(0,0,0,0.35)]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h3 className="text-xl font-semibold">{tr("输入动态码", "Enter your code")}</h3>
        <p className="mt-2 mb-4 text-sm text-muted-fg">{tr(`「${opLabel(req.cmd, false)}」需要两步验证。`, `"${opLabel(req.cmd, true)}" needs two-step verification.`)}</p>
        {recovery ? (
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="xxxx-xxxx" autoFocus invalid={!!req.error} className="num" />
        ) : (
          <OtpCells value={code} onChange={setCode} onComplete={(v) => submit(v)} autoFocus invalid={!!req.error} />
        )}
        {req.error ? <div className="mt-2 text-xs text-danger">{req.error}</div> : null}
        <button
          type="button"
          className="mt-3 text-xs text-primary hover:underline"
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
          }}
        >
          {recovery ? tr("改用验证器动态码", "Use the authenticator code") : tr("换用恢复码", "Use a recovery code")}
        </button>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" onClick={() => finish(null)}>
            {tr("取消", "Cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={recovery ? code.trim().length < 8 : code.length !== 6}>
            {tr("确认", "Confirm")}
          </Button>
        </div>
        <p className="mt-4 text-xs text-muted-fg">{en ? "Submits once 6 digits are in; 5 wrong codes in a row lock checking for 5 minutes." : "输入满 6 位自动提交；连续错 5 次锁定 5 分钟。"}</p>
      </form>
    </div>
  );
}
