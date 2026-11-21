import { create } from "zustand";

export type Page = "overview" | "tasks" | "task" | "wizard" | "sources" | "plaza" | "compare" | "connections" | "records" | "settings";

export interface Route {
  page: Page;
  id?: string;
  /** Wizard: preselected source id. */
  src?: string;
  /** Wizard: allocated capital carried over from the plaza simulation. */
  capital?: string;
  /** Wizard: editing a watch task to turn it into a copy task. */
  convert?: boolean;
  /** Compare: the wallet addresses side by side. */
  addrs?: string[];
}

interface UiState {
  route: Route;
  lang: "zh" | "en";
  theme: "dark" | "light" | "system";
  toasts: { id: number; kind: "ok" | "error" | "info"; text: string }[];
  go: (page: Page, id?: string, src?: string, capital?: string) => void;
  goTo: (route: Route) => void;
  setLang: (l: "zh" | "en") => void;
  setTheme: (t: "dark" | "light" | "system") => void;
  toast: (text: string, kind?: "ok" | "error" | "info") => void;
  dismiss: (id: number) => void;
}

let toastId = 0;

export const useUi = create<UiState>((set) => ({
  route: { page: "overview" },
  lang: "zh",
  theme: "dark",
  toasts: [],
  go: (page, id, src, capital) => set({ route: { page, id, src, capital } }),
  goTo: (route) => set({ route }),
  setLang: (lang) => set({ lang }),
  setTheme: (theme) => set({ theme }),
  toast: (text, kind = "ok") => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 6000 : 3000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function applyTheme(theme: "dark" | "light" | "system") {
  const resolved = theme === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
  document.documentElement.dataset.theme = resolved;
}
