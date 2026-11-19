import { QueryClient, keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { api, errMsg, type ChartInterval, type PnlRange } from "./api";
import { subscribe } from "./server";
import { useUi } from "./store";

export const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000, refetchOnWindowFocus: false, retry: 1 } },
});

/** Map engine change scopes to the queries they invalidate. */
const scopeKeys: Record<string, string[][]> = {
  tasks: [["tasks"], ["task"], ["overview"], ["health"]],
  live: [["task"], ["overview"], ["tasks"]],
  orders: [["task"], ["task-chart"], ["logs"], ["overview"]],
  signals: [["task"], ["logs"]],
  mirrors: [["task"], ["source"]],
  alerts: [["overview"], ["alerts"]],
  equity: [["overview"], ["connections"], ["tasks"], ["pnl-curve"]],
  connections: [["connections"], ["overview"]],
  sources: [["sources"]],
  estop: [["health"], ["overview"], ["tasks"], ["task"]],
  settings: [["settings"]],
  symbols: [["symbols"]],
  lock: [["health"]],
  secrets: [["health"]],
  all: [[]],
};

let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function notify(title: string, body: string) {
  // Web Notifications need a secure context (HTTPS or localhost).
  if (typeof Notification === "undefined") return;
  try {
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm === "granted") new Notification(title, { body, icon: "/favicon.svg" });
  } catch {
    /* notifications unavailable */
  }
}

/** Server events → query invalidation and desktop notifications. Returns an unsubscribe function. */
export function subscribeEngine() {
  return subscribe(
    (e) => {
      if (e.kind === "alert") {
        const settings = qc.getQueryData<{ notifications: boolean }>(["settings"]);
        if (settings?.notifications ?? true) notify(e.title, e.detail ?? "");
        pending.add("alerts");
      } else if (e.scope) {
        pending.add(e.scope);
      } else return;
      // Coalesce bursts (a step can emit several scopes).
      if (!timer)
        timer = setTimeout(() => {
          const keys = new Set<string>();
          pending.forEach((s) => (scopeKeys[s] ?? []).forEach((k) => keys.add(JSON.stringify(k))));
          pending = new Set();
          timer = null;
          keys.forEach((k) => qc.invalidateQueries({ queryKey: JSON.parse(k) }));
        }, 250);
    },
    // (Re)connected: refetch whatever may have changed while disconnected.
    () => qc.invalidateQueries(),
  );
}

export const useHealth = () => useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 5000 });
export const useOverview = () => useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 10000 });
export const useTasks = () => useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 10000 });
export const useTask = (id?: string) => useQuery({ queryKey: ["task", id], queryFn: () => api.task(id!), enabled: !!id, refetchInterval: 5000 });
export const useTaskChart = (taskId: string | undefined, base: string | undefined, interval: ChartInterval) =>
  useQuery({ queryKey: ["task-chart", taskId, base ?? "", interval], queryFn: () => api.taskChart({ taskId: taskId!, base, interval }), enabled: !!taskId, refetchInterval: 30000, placeholderData: keepPreviousData });
export const usePnlCurve = (range: PnlRange) => useQuery({ queryKey: ["pnl-curve", range], queryFn: () => api.pnlCurve(range), refetchInterval: 60000, placeholderData: keepPreviousData });
export const useConnections = () => useQuery({ queryKey: ["connections"], queryFn: api.connections, refetchInterval: 30000 });
export const useSources = () => useQuery({ queryKey: ["sources"], queryFn: api.sources });
// The server crawls progressively; poll faster until every wallet is scored.
export const usePlaza = () =>
  useQuery({ queryKey: ["plaza"], queryFn: api.plaza, refetchInterval: (q) => (q.state.data && q.state.data.status.analyzed >= q.state.data.status.total ? 120_000 : 10_000) });
export const usePlazaWallet = (address: string | null) => useQuery({ queryKey: ["plaza-wallet", address], queryFn: () => api.plazaWallet(address!), enabled: !!address, staleTime: 30_000 });
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: api.settings });

/** Mutation with toast on error and query invalidation on success. */
export function useAction<A, R>(fn: (a: A) => Promise<R>, opts?: { ok?: string | ((r: R) => string); invalidate?: string[][] }) {
  const toast = useUi((s) => s.toast);
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts?.ok) toast(typeof opts.ok === "function" ? opts.ok(r) : opts.ok, "ok");
      (opts?.invalidate ?? []).forEach((k) => qc.invalidateQueries({ queryKey: k }));
    },
    onError: (e) => toast(errMsg(e), "error"),
  });
}
