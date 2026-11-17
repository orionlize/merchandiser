import { useUi } from "./store";

/** Inline bilingual strings: tr("总览", "Overview"). */
export function useTr() {
  const lang = useUi((s) => s.lang);
  return (zh: string, en: string) => (lang === "en" ? en : zh);
}

export function trNow(zh: string, en: string) {
  return useUi.getState().lang === "en" ? en : zh;
}
