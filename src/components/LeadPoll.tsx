import { api, type LeadPoll, type Source } from "../lib/api";
import { useTr } from "../lib/i18n";
import { useAction } from "../lib/queries";
import { Seg } from "./ui";

export const leadPollOf = (s: Pick<Source, "lead_poll">): LeadPoll => (s.lead_poll === "trigger" ? "trigger" : "interval");

/** Whether a source follows a lead trader from reconstructed fills (the only kind with a poll mode). */
export const hasLeadPoll = (s: Source | undefined | null): s is Source => !!s && s.kind === "lead_trader" && s.lead_mode === "fills";

export function useLeadPollText() {
  const tr = useTr();
  return {
    interval: { label: tr("定时轮询", "Interval"), hint: tr("每 6 秒读一次成交记录。", "Reads the trade history every 6 s.") },
    trigger: {
      label: tr("动作触发", "On activity"),
      hint: tr(
        "每 2 秒查一次带单员的「最近交易时间」，一变就立即读成交记录，空闲时每 30 秒兜底读一次。成交接口请求更少、更不容易被限流。",
        "Checks the trader's last-trade time every 2 s and reads the trade history as soon as it moves (plus every 30 s as a fallback). Fewer trade-history requests, less rate limiting.",
      ),
    },
  };
}

/** Switch a "fills" lead source between interval polling and activity trigger; running tasks pick it up at once. */
export function LeadPollSwitch({ source, size = "sm", showHint = true }: { source: Source; size?: "sm" | "md"; showHint?: boolean }) {
  const tr = useTr();
  const text = useLeadPollText();
  const value = leadPollOf(source);
  const mut = useAction((v: LeadPoll) => api.setSourceLeadPoll({ id: source.id, lead_poll: v }), {
    ok: tr("读取方式已切换，正在运行的任务立即生效", "Switched; running tasks use it right away"),
    invalidate: [["sources"], ["source", source.id], ["tasks"], ["task"]],
  });
  const shown = mut.isPending && mut.variables ? mut.variables : value;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-fg">{tr("成交读取", "Fills polling")}</span>
        <Seg
          size={size}
          value={shown}
          onChange={(v) => v !== value && !mut.isPending && mut.mutate(v)}
          options={[
            { value: "interval", label: text.interval.label },
            { value: "trigger", label: text.trigger.label },
          ]}
        />
      </div>
      {showHint ? <div className="text-xs text-muted-fg">{text[shown].hint}</div> : null}
    </div>
  );
}
