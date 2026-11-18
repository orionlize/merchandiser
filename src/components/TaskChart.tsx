import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Candle, ChartInterval } from "../lib/api";
import type { ReplayedFill } from "../lib/replay";
import { trNow } from "../lib/i18n";

const STEP: Record<ChartInterval, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
/** Above this many marker groups, add/trim dots lose their labels. */
const LABEL_LIMIT = 30;

/** lightweight-charts renders UTC; shift timestamps so the axis reads local time. */
const local = (ms: number) => ((ms - new Date(ms).getTimezoneOffset() * 60_000) / 1000) as UTCTimestamp;

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function palette() {
  return {
    bg: css("--card"),
    fg: css("--fg"),
    muted: css("--muted-fg"),
    border: css("--border"),
    up: css("--success"),
    down: css("--danger"),
    avg: css("--chart-avg"),
    primary: css("--primary"),
  };
}

export function fillLabel(f: ReplayedFill) {
  switch (f.kind) {
    case "open":
      return trNow("开", "Open");
    case "add":
      return trNow(`加${f.addNo}`, `Add ${f.addNo}`);
    case "reduce":
      return trNow("减", "Trim");
    case "close":
      return trNow("平", "Close");
    case "flip":
      return trNow("反", "Flip");
  }
}

/** Higher wins when several fills merge into one marker. */
const RANK: Record<ReplayedFill["kind"], number> = { reduce: 0, add: 1, close: 2, open: 3, flip: 4 };
/** Markers closer than this on screen are merged. */
const MIN_GAP_PX = 14;

/**
 * Bars per marker group at the current zoom: 1 when bars are wide enough,
 * otherwise a power of two so small zooms don't regroup.
 */
function bucketFor(barSpacing: number) {
  const k = Math.ceil(MIN_GAP_PX / Math.max(barSpacing, 0.01));
  return k <= 1 ? 1 : 2 ** Math.ceil(Math.log2(k));
}

/**
 * One marker per side for every `bucket` bars. Opens, closes and flips keep
 * an arrow; groups of only adds or trims get a small dot, so scaling in and
 * out does not bury the candles. The label is the most significant kind plus
 * the count; zoomed out (bucket > 1) only the selection keeps its label.
 */
function buildMarkers(candles: Candle[], fills: ReplayedFill[], selected: number | null, bucket: number, p: ReturnType<typeof palette>): SeriesMarker<Time>[] {
  const groups = new Map<string, { bar: number; buy: boolean; fills: ReplayedFill[] }>();
  for (const f of fills) {
    const bar = barIndex(candles, f.ts);
    if (bar < 0) continue;
    const key = `${Math.floor(bar / bucket)}:${f.buy ? 1 : 0}`;
    const g = groups.get(key);
    if (g) {
      g.fills.push(f);
      g.bar = bar;
    } else groups.set(key, { bar, buy: f.buy, fills: [f] });
  }
  const list = [...groups.values()].sort((a, b) => a.bar - b.bar || Number(a.buy) - Number(b.buy));
  const labels = bucket === 1;
  const fewGroups = list.length <= LABEL_LIMIT;
  return list.map(({ bar, buy, fills: fs }) => {
    const top = fs.reduce((a, f) => (RANK[f.kind] >= RANK[a.kind] ? f : a));
    const sel = fs.find((f) => f.id === selected);
    const minor = top.kind === "add" || top.kind === "reduce";
    const n = fs.length;
    const label = minor ? (top.kind === "add" ? trNow("加", "Add") : trNow("减", "Trim")) : fillLabel(top);
    const show = sel || (labels && (fewGroups || !minor));
    return {
      // Clicking selects the latest fill in the group.
      id: `f${(sel ?? fs[n - 1]).id}`,
      time: local(candles[bar].t),
      position: buy ? "belowBar" : "aboveBar",
      shape: minor ? "circle" : buy ? "arrowUp" : "arrowDown",
      color: sel ? p.primary : buy ? p.up : p.down,
      text: show ? (n > 1 ? `${label}×${n}` : label) : undefined,
      size: sel ? 1.4 : minor ? 0.5 : 0.9,
    };
  });
}

/** Index of the last candle starting at or before ts, or -1. */
function barIndex(candles: Candle[], ts: number) {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= ts) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

interface Props {
  candles: Candle[];
  fills: ReplayedFill[];
  interval: ChartInterval;
  avg: number;
  pos: number;
  selected: number | null;
  onSelect: (id: number | null) => void;
  /** Refit the view when this changes (coin or timeframe switch). */
  viewKey: string;
  height?: number;
}

/**
 * Candles with every copied fill marked on its bar, the running average
 * entry as a stepped dashed line, and the position size in a pane below.
 */
export function TaskChart({ candles, fills, interval, avg, pos, selected, onSelect, viewKey, height = 420 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const avgLine = useRef<ISeriesApi<"Line"> | null>(null);
  const posLine = useRef<ISeriesApi<"Line"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const avgPrice = useRef<IPriceLine | null>(null);
  // Latest props for the click handler, which is bound once.
  const state = useRef({ candles, fills, onSelect });
  state.current = { candles, fills, onSelect };
  const fitKey = useRef("");
  // Markers are regrouped when zooming changes how many bars share a group.
  const bucket = useRef(1);
  const drawMarkers = useRef(() => {});

  // Build the chart once; colors follow the theme attribute.
  useEffect(() => {
    const el = box.current!;
    const p = palette();
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: p.muted, fontSize: 11, attributionLogo: false, panes: { separatorColor: p.border } },
      grid: { vertLines: { color: p.border }, horzLines: { color: p.border } },
      rightPriceScale: { borderColor: p.border },
      timeScale: { borderColor: p.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const cs = c.addSeries(CandlestickSeries, { upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down, borderVisible: false, priceLineStyle: LineStyle.Dotted });
    const al = c.addSeries(LineSeries, { color: p.avg, lineWidth: 1, lineStyle: LineStyle.Dashed, lineType: LineType.WithSteps, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const pl = c.addSeries(LineSeries, { color: p.primary, lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceFormat: { type: "volume" } }, 1);
    c.panes()[1]?.setHeight(80);
    chart.current = c;
    price.current = cs;
    avgLine.current = al;
    posLine.current = pl;
    markers.current = createSeriesMarkers(cs, []);

    const click = (e: MouseEventParams<Time>) => {
      const { candles, fills, onSelect } = state.current;
      const hit = e.hoveredInfo?.objectId ?? e.hoveredObjectId;
      if (typeof hit === "string" && hit.startsWith("f")) return onSelect(Number(hit.slice(1)));
      if (e.time == null) return onSelect(null);
      // Clicked a bar: pick the last fill on it.
      const bar = candles.findIndex((k) => local(k.t) === e.time);
      if (bar < 0) return onSelect(null);
      const hits = fills.filter((f) => barIndex(candles, f.ts) === bar);
      onSelect(hits.length ? hits[hits.length - 1].id : null);
    };
    c.subscribeClick(click);

    const zoom = () => {
      const r = c.timeScale().getVisibleLogicalRange();
      const w = c.timeScale().width();
      if (!r || w <= 0) return;
      const k = bucketFor(w / Math.max(1, r.to - r.from));
      if (k !== bucket.current) {
        bucket.current = k;
        drawMarkers.current();
      }
    };
    c.timeScale().subscribeVisibleLogicalRangeChange(zoom);

    const recolor = () => {
      const p = palette();
      c.applyOptions({ layout: { textColor: p.muted, panes: { separatorColor: p.border } }, grid: { vertLines: { color: p.border }, horzLines: { color: p.border } }, rightPriceScale: { borderColor: p.border }, timeScale: { borderColor: p.border } });
      cs.applyOptions({ upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down });
      al.applyOptions({ color: p.avg });
      pl.applyOptions({ color: p.primary });
      avgPrice.current?.applyOptions({ color: p.avg });
    };
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mo.disconnect();
      c.unsubscribeClick(click);
      c.timeScale().unsubscribeVisibleLogicalRangeChange(zoom);
      c.remove();
      chart.current = null;
    };
  }, []);

  // Data.
  useEffect(() => {
    const c = chart.current;
    if (!c || !price.current || !avgLine.current || !posLine.current || !markers.current) return;
    const p = palette();
    const step = STEP[interval];
    price.current.setData(candles.map((k) => ({ time: local(k.t), open: k.o, high: k.h, low: k.l, close: k.c })));

    // Position and average as of each bar's close.
    const avgData: (LineData | WhitespaceData)[] = [];
    const posData: LineData[] = [];
    let i = 0;
    let cur: ReplayedFill | null = null;
    for (const k of candles) {
      while (i < fills.length && fills[i].ts < k.t + step) cur = fills[i++];
      const time = local(k.t);
      const size = cur?.pos ?? 0;
      posData.push({ time, value: size, color: size > 0 ? p.up : size < 0 ? p.down : p.muted });
      avgData.push(cur && Math.abs(size) > 1e-12 ? { time, value: cur.avg } : { time });
    }
    avgLine.current.setData(avgData);
    posLine.current.setData(posData);

    const m = markers.current;
    drawMarkers.current = () => m.setMarkers(buildMarkers(candles, fills, selected, bucket.current, palette()));
    drawMarkers.current();

    if (avgPrice.current) price.current.removePriceLine(avgPrice.current);
    avgPrice.current = Math.abs(pos) > 1e-12 && avg > 0 ? price.current.createPriceLine({ price: avg, color: p.avg, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: trNow("均价", "Avg") }) : null;

    // Fit only when the dataset changes identity, not on every refetch.
    const key = `${viewKey}:${candles.length > 0}`;
    if (key !== fitKey.current) {
      fitKey.current = key;
      c.timeScale().fitContent();
    }
  }, [candles, fills, interval, avg, pos, selected, viewKey]);

  return <div ref={box} style={{ height }} className="w-full" />;
}
