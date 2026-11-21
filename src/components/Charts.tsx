import clsx from "clsx";
import { BaselineSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { trNow } from "../lib/i18n";

const local = (ms: number) => ((ms - new Date(ms).getTimezoneOffset() * 60_000) / 1000) as UTCTimestamp;
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
/** "#2ebd85" → "rgba(46,189,133,a)" for canvas fills. */
function alpha(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Largest peak-to-trough fall of a PnL curve, with the bars it spans. */
export function maxDrawdown(points: [number, number][]) {
  let peak = -Infinity;
  let peakAt = 0;
  let dd = 0;
  let from = 0;
  let to = 0;
  for (const [t, v] of points) {
    if (v > peak) {
      peak = v;
      peakAt = t;
    }
    if (peak - v > dd) {
      dd = peak - v;
      from = peakAt;
      to = t;
    }
  }
  return { dd, from, to };
}

/** Cumulative PnL as a baseline area: green above zero, red below; the worst drawdown is marked. */
/** 139282626 → "139.3M" (axis labels for large curves). */
function compactNum(v: number) {
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0);
  return (v < 0 ? "−" : "") + s;
}

export function PnlCurveChart({ points, height = 260, compact = false }: { points: [number, number][]; height?: number; compact?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Baseline"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted-fg"), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--border") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3 },
      crosshair: { mode: CrosshairMode.Magnet },
      handleScroll: false,
      handleScale: false,
      ...(compact ? { localization: { priceFormatter: compactNum } } : {}),
    });
    const s = c.addSeries(BaselineSeries, { baseValue: { type: "price", price: 0 }, lineWidth: 2, priceLineVisible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    chart.current = c;
    series.current = s;
    markers.current = createSeriesMarkers(s, []);
    const recolor = () => {
      const up = css("--success");
      const dn = css("--danger");
      c.applyOptions({ layout: { textColor: css("--muted-fg") }, grid: { horzLines: { color: css("--border") } } });
      s.applyOptions({
        topLineColor: up,
        topFillColor1: alpha(up, 0.28),
        topFillColor2: alpha(up, 0.02),
        bottomLineColor: dn,
        bottomFillColor1: alpha(dn, 0.02),
        bottomFillColor2: alpha(dn, 0.28),
      });
    };
    recolor();
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mo.disconnect();
      c.remove();
    };
  }, []);

  useEffect(() => {
    if (!series.current || !chart.current) return;
    // De-duplicate shifted timestamps (DST) so times stay strictly increasing.
    const data: { time: UTCTimestamp; value: number }[] = [];
    for (const [t, v] of points) {
      const time = local(t);
      if (data.length && data[data.length - 1].time >= time) data[data.length - 1].value = v;
      else data.push({ time, value: v });
    }
    series.current.setData(data);
    const { dd, to } = maxDrawdown(points);
    markers.current?.setMarkers(dd > 0 && to ? [{ time: local(to), position: "belowBar", shape: "arrowUp", color: css("--danger"), text: trNow("回撤", "DD") }] : []);
    chart.current.timeScale().fitContent();
  }, [points]);

  return <div ref={box} style={{ height }} className="w-full" />;
}

/** Strictly increasing local-time points for a line series. */
function lineData(points: [number, number][]) {
  const data: { time: UTCTimestamp; value: number }[] = [];
  for (const [t, v] of points) {
    const time = local(t);
    if (data.length && data[data.length - 1].time >= time) data[data.length - 1].value = v;
    else data.push({ time, value: v });
  }
  return data;
}

/** Follow simulation: the simulated PnL (primary) against the trader's PnL scaled to the same capital (dashed). */
export function SimCurveChart({ curve, height = 180 }: { curve: [number, number, number][]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const sim = useRef<ISeriesApi<"Line"> | null>(null);
  const trader = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted-fg"), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--border") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 2 },
      crosshair: { mode: CrosshairMode.Magnet },
      handleScroll: false,
      handleScale: false,
      localization: { priceFormatter: compactNum },
    });
    const fmt = { type: "price" as const, precision: 2, minMove: 0.01 };
    trader.current = c.addSeries(LineSeries, { lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, priceFormat: fmt });
    sim.current = c.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, priceFormat: fmt });
    chart.current = c;
    const recolor = () => {
      c.applyOptions({ layout: { textColor: css("--muted-fg") }, grid: { horzLines: { color: css("--border") } } });
      sim.current?.applyOptions({ color: css("--primary") });
      trader.current?.applyOptions({ color: css("--chart-avg") });
    };
    recolor();
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // autoSize measures after the first fit, so fit again once the width is known.
    const ro = new ResizeObserver(() => c.timeScale().fitContent());
    ro.observe(box.current!);
    return () => {
      mo.disconnect();
      ro.disconnect();
      c.remove();
    };
  }, []);

  useEffect(() => {
    sim.current?.setData(lineData(curve.map((p) => [p[0], p[1]])));
    trader.current?.setData(lineData(curve.map((p) => [p[0], p[2]])));
    chart.current?.timeScale().fitContent();
  }, [curve]);

  return <div ref={box} style={{ height }} className="w-full" />;
}

/** Several return curves (fractions) on one percent axis; colours come from --series-N. */
export function ReturnsChart({ series, height = 220 }: { series: { key: string; points: [number, number][] }[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const lines = useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted-fg"), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--border") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 2 },
      crosshair: { mode: CrosshairMode.Magnet },
      handleScroll: false,
      handleScale: false,
      localization: { priceFormatter: (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v * 100).toFixed(1)}%` },
    });
    chart.current = c;
    const recolor = () => c.applyOptions({ layout: { textColor: css("--muted-fg") }, grid: { horzLines: { color: css("--border") } } });
    recolor();
    const mo = new MutationObserver(() => {
      recolor();
      let i = 0;
      for (const l of lines.current.values()) l.applyOptions({ color: css(`--series-${++i}`) });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const ro = new ResizeObserver(() => c.timeScale().fitContent());
    ro.observe(box.current!);
    const map = lines.current;
    return () => {
      mo.disconnect();
      ro.disconnect();
      map.clear();
      c.remove();
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    for (const l of lines.current.values()) c.removeSeries(l);
    lines.current.clear();
    series.forEach((s, i) => {
      const l = c.addSeries(LineSeries, { lineWidth: 2, color: css(`--series-${i + 1}`), priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } });
      l.setData(lineData(s.points));
      lines.current.set(s.key, l);
    });
    c.timeScale().fitContent();
  }, [series]);

  return <div ref={box} style={{ height }} className="w-full" />;
}

/** Tiny cumulative line for a series of period PnLs. */
export function Spark({ values, width = 96, height = 28, className }: { values: number[]; width?: number; height?: number; className?: string }) {
  if (values.length < 2) return <svg width={width} height={height} className={className} />;
  const cum: number[] = [];
  values.reduce((a, v) => (cum.push(a + v), a + v), 0);
  const all = [0, ...cum];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const pts = all.map((v, i) => `${((i / (all.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`);
  const last = all[all.length - 1];
  const color = last > 0 ? "var(--success)" : last < 0 ? "var(--danger)" : "var(--muted-fg)";
  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/** Day-by-day PnL from a cumulative curve: [local day start ms, pnl]. */
export function dailyFromCurve(points: [number, number][]) {
  const out: [number, number][] = [];
  let prev = 0;
  let day = -1;
  let last = 0;
  for (const [t, v] of points) {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    const k = d.getTime();
    if (k !== day) {
      if (day >= 0) {
        out.push([day, last - prev]);
        prev = last;
      }
      day = k;
    }
    last = v;
  }
  if (day >= 0) out.push([day, last - prev]);
  return out;
}

/** Up / down bars around a zero line; the newest bar is drawn lighter while the day is open. */
export function DailyBars({ days, height = 120 }: { days: [number, number][]; height?: number }) {
  const pos = Math.max(...days.map((d) => d[1]), 0);
  const neg = Math.max(...days.map((d) => -d[1]), 0);
  const up = pos + neg > 0 ? (pos / (pos + neg)) * height : height / 2;
  const k = pos + neg > 0 ? height / (pos + neg) : 0;
  const today = new Date().setHours(0, 0, 0, 0);
  return (
    <div className="relative flex gap-[3px]" style={{ height }}>
      <div className="absolute inset-x-0 h-px bg-border" style={{ top: up }} />
      {days.map(([d, v]) => (
        <div key={d} className="group relative flex min-w-0 flex-1 flex-col" title={`${new Date(d).toLocaleDateString()}  ${v >= 0 ? "+" : ""}${v.toFixed(2)}`}>
          <div className="flex flex-col justify-end" style={{ height: up }}>
            {v > 0 ? <div className={clsx("w-full bg-success", d === today && "opacity-50")} style={{ height: Math.max(1, v * k) }} /> : null}
          </div>
          <div style={{ height: height - up }}>{v < 0 ? <div className={clsx("w-full bg-danger", d === today && "opacity-50")} style={{ height: Math.max(1, -v * k) }} /> : null}</div>
        </div>
      ))}
    </div>
  );
}
