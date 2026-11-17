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
/** Above this many markers in view, labels are dropped so arrows stay readable. */
const LABEL_LIMIT = 60;

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

    const visible = fills.filter((f) => barIndex(candles, f.ts) >= 0);
    const labels = visible.length <= LABEL_LIMIT;
    const ms: SeriesMarker<Time>[] = visible.map((f) => {
      const sel = f.id === selected;
      return {
        id: `f${f.id}`,
        time: local(candles[barIndex(candles, f.ts)].t),
        position: f.buy ? "belowBar" : "aboveBar",
        shape: f.buy ? "arrowUp" : "arrowDown",
        color: sel ? p.primary : f.buy ? p.up : p.down,
        text: labels || sel ? fillLabel(f) : undefined,
        size: sel ? 1.6 : 1,
      };
    });
    markers.current.setMarkers(ms);

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
