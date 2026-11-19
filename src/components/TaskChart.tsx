import clsx from "clsx";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type Logical,
  type MouseEventParams,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import { Check, ChartLine, ChevronDown, Lock, LockOpen, Magnet, Minus, MousePointer2, MoveUpRight, Trash2, TrendingUp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Candle, ChartInterval } from "../lib/api";
import { num, price as fmtPrice, qty } from "../lib/format";
import { trNow, useTr } from "../lib/i18n";
import { boll, ema, macd, rsi, sma, type Series } from "../lib/indicators";
import type { ReplayedFill } from "../lib/replay";
import { DRAW_COLORS, drawColor, DrawingLayer, handles, hitTest, loadDrawings, saveDrawings, type Anchor, type DrawColor, type Drawing, type DrawKind, type Mapper, type Part } from "./chart/drawings";

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

// ---- Indicators -------------------------------------------------------------

export type IndKey = "ma" | "ema" | "boll" | "vol" | "macd" | "rsi";
const OVERLAYS: IndKey[] = ["ma", "ema", "boll", "vol"];
const SUBS: IndKey[] = ["macd", "rsi"];
const IND_KEY = "merchandiser.chartIndicators";
const DEFAULT_IND: IndKey[] = ["ma", "vol"];

/** Fixed hues that stay clear of the brand yellow, up/down and the avg-entry blue in both themes. */
const C = { ma: ["#b46be0", "#e8912d", "#2fa9c4"], ema: ["#e0719b", "#7c8cf0"], boll: "#8a919c", dif: "#e8912d", dea: "#2fa9c4", rsi: "#b46be0" };

const IND_LABEL: Record<IndKey, [string, string, string]> = {
  ma: ["MA 移动平均", "MA", "7 / 25 / 60"],
  ema: ["EMA 指数平均", "EMA", "12 / 26"],
  boll: ["BOLL 布林带", "Bollinger", "20, 2"],
  vol: ["VOL 成交量", "Volume", ""],
  macd: ["MACD", "MACD", "12 / 26 / 9"],
  rsi: ["RSI 相对强弱", "RSI", "14"],
};
const CHIP: Record<IndKey, string> = { ma: "MA 7/25/60", ema: "EMA 12/26", boll: "BOLL 20,2", vol: "VOL", macd: "MACD 12/26/9", rsi: "RSI 14" };

function savedIndicators(): IndKey[] {
  try {
    const v = JSON.parse(localStorage.getItem(IND_KEY) ?? "null");
    if (Array.isArray(v)) return v.filter((k): k is IndKey => (OVERLAYS as string[]).includes(k) || (SUBS as string[]).includes(k));
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_IND;
}

function store(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

const MAG_KEY = "merchandiser.chartMagnet";
function savedMagnet() {
  try {
    return localStorage.getItem(MAG_KEY) !== "0";
  } catch {
    return true;
  }
}

function compact(v: number) {
  const a = Math.abs(v);
  if (a >= 1e9) return num(v / 1e9, 2) + "B";
  if (a >= 1e6) return num(v / 1e6, 2) + "M";
  if (a >= 1e3) return num(v / 1e3, 2) + "K";
  return num(v, a >= 100 ? 0 : 2);
}

const line = (candles: Candle[], s: Series): (LineData | WhitespaceData)[] => candles.map((k, i) => (s[i] == null ? { time: local(k.t) } : { time: local(k.t), value: s[i]! }));

type Tool = "cursor" | DrawKind;
let seq = 0;
const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

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
  /** Drawings are saved per key (task + coin), independent of the timeframe. */
  drawKey: string;
  /** Height of the main and position panes; each indicator pane adds to it. */
  height?: number;
  /** Phone layout: icon-only tools, a bottom sheet for indicators, one indicator pane. */
  compact?: boolean;
}

/**
 * Candles with every copied fill marked on its bar, the running average entry
 * as a stepped dashed line, optional indicators, user drawings, and the
 * position size in the bottom pane.
 */
export function TaskChart({ candles, fills, interval, avg, pos, selected, onSelect, viewKey, drawKey, height = 420, compact: isCompact = false }: Props) {
  const tr = useTr();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const avgLine = useRef<ISeriesApi<"Line"> | null>(null);
  const posLine = useRef<ISeriesApi<"Line"> | null>(null);
  const extras = useRef<Partial<Record<IndKey, ISeriesApi<SeriesType>[]>>>({});
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const avgPrice = useRef<IPriceLine | null>(null);
  const layer = useRef<DrawingLayer | null>(null);
  // Latest props for handlers that are bound once.
  const state = useRef({ candles, fills, onSelect, step: STEP[interval], drawKey });
  state.current = { candles, fills, onSelect, step: STEP[interval], drawKey };
  const fitKey = useRef("");
  // Markers are regrouped when zooming changes how many bars share a group.
  const bucket = useRef(1);
  const drawMarkers = useRef(() => {});

  const [ind, setIndState] = useState<IndKey[]>(savedIndicators);
  const subLimit = isCompact ? 1 : 2;
  const subs = SUBS.filter((k) => ind.includes(k)).slice(0, subLimit);
  const on = (k: IndKey) => (SUBS.includes(k) ? subs.includes(k) : ind.includes(k));
  const layoutKey = [...OVERLAYS.filter((k) => ind.includes(k)), ...subs].join(",");
  const toggleInd = (k: IndKey) => {
    let next = on(k) ? ind.filter((x) => x !== k) : [...ind.filter((x) => !SUBS.includes(x) || subs.includes(x)), k];
    const s = next.filter((x) => SUBS.includes(x));
    if (s.length > subLimit) next = next.filter((x) => x !== s[0]);
    setIndState(next);
    store(IND_KEY, JSON.stringify(next));
  };

  const [tool, setToolState] = useState<Tool>("cursor");
  const toolRef = useRef<Tool>("cursor");
  const setTool = (t: Tool) => {
    toolRef.current = t;
    setToolState(t);
    const L = layer.current;
    if (L?.draft) {
      L.draft = null;
      L.update();
    }
  };
  const [magnet, setMagnetState] = useState(savedMagnet);
  const magRef = useRef(magnet);
  const setMagnet = (v: boolean) => {
    magRef.current = v;
    setMagnetState(v);
    store(MAG_KEY, v ? "1" : "0");
  };
  const [sel, setSel] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const [hover, setHover] = useState<number | null>(null);
  const [paneTops, setPaneTops] = useState<number[]>([]);
  const [themeTick, setThemeTick] = useState(0);
  const [menu, setMenu] = useState(false);
  const [colors, setColors] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // ---- Coordinate mapping (refs only, so it can be built once) ----
  const helpers = useRef<{
    mapper: Mapper;
    anchorAt: (x: number, y: number, snap?: boolean) => Anchor | null;
    select: (id: string | null) => void;
    commit: (list: Drawing[]) => void;
    finish: (d: Drawing) => void;
  } | null>(null);
  if (!helpers.current) {
    const toLogical = (t: number) => {
      const { candles: ks, step } = state.current;
      const n = ks.length;
      if (!n) return null;
      const i = barIndex(ks, t);
      if (i < 0) return (t - ks[0].t) / step;
      const frac = (t - ks[i].t) / step;
      return i + (i < n - 1 ? Math.min(frac, 1) : frac);
    };
    const toTime = (lg: number) => {
      const { candles: ks, step } = state.current;
      const n = ks.length;
      if (!n) return null;
      const i = Math.min(Math.max(Math.floor(lg), 0), n - 1);
      return ks[i].t + (lg - i) * step;
    };
    const mapper: Mapper = {
      x: (t) => {
        const lg = toLogical(t);
        return lg == null || !chart.current ? null : chart.current.timeScale().logicalToCoordinate(lg as Logical);
      },
      y: (p) => price.current?.priceToCoordinate(p) ?? null,
      width: () => chart.current?.timeScale().width() ?? 0,
    };
    const anchorAt = (x: number, y: number, snap = magRef.current): Anchor | null => {
      const c = chart.current;
      const s = price.current;
      if (!c || !s) return null;
      const lg = c.timeScale().coordinateToLogical(x);
      const p = s.coordinateToPrice(y);
      if (lg == null || p == null) return null;
      const t = toTime(lg);
      if (t == null) return null;
      if (!snap) return { t, p };
      const k = state.current.candles[Math.round(lg)];
      if (!k) return { t, p };
      // Snap to the nearest OHLC value of the bar when it is within reach.
      let best: number = p;
      let dist = 14;
      for (const v of [k.o, k.h, k.l, k.c]) {
        const vy = s.priceToCoordinate(v);
        if (vy != null && Math.abs(vy - y) < dist) {
          dist = Math.abs(vy - y);
          best = v;
        }
      }
      return { t: k.t, p: best };
    };
    const select = (id: string | null) => {
      const L = layer.current;
      if (!L) return;
      L.selected = id;
      setSel(id);
      setColors(false);
      L.update();
    };
    const commit = (list: Drawing[]) => {
      const L = layer.current;
      if (!L) return;
      L.drawings = list;
      saveDrawings(state.current.drawKey, list);
      L.update();
      bump();
    };
    const finish = (d: Drawing) => {
      const L = layer.current;
      if (!L) return;
      L.draft = null;
      commit([...L.drawings, d]);
      select(d.id);
      toolRef.current = "cursor";
      setToolState("cursor");
    };
    helpers.current = { mapper, anchorAt, select, commit, finish };
  }
  const { mapper, select, commit } = helpers.current;

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
    chart.current = c;
    price.current = cs;
    avgLine.current = al;
    markers.current = createSeriesMarkers(cs, []);
    const L = new DrawingLayer(helpers.current!.mapper);
    L.drawings = loadDrawings(state.current.drawKey);
    cs.attachPrimitive(L);
    layer.current = L;

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

    const move = (e: MouseEventParams<Time>) => setHover(e.point && e.logical != null ? Math.round(e.logical) : null);
    c.subscribeCrosshairMove(move);

    const zoom = () => {
      if (layer.current?.selected) bump();
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
      avgPrice.current?.applyOptions({ color: p.avg });
      setThemeTick((t) => t + 1);
    };
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mo.disconnect();
      c.unsubscribeClick(click);
      c.unsubscribeCrosshairMove(move);
      c.timeScale().unsubscribeVisibleLogicalRangeChange(zoom);
      c.remove();
      chart.current = null;
      layer.current = null;
      posLine.current = null;
      extras.current = {};
    };
  }, []);

  // Drawing interaction. Pointer events on a drawing (or while a drawing tool
  // is active) are captured before the chart sees them, so the chart neither
  // pans nor reports a click.
  useEffect(() => {
    const el = box.current!;
    const h = helpers.current!;
    const pt = (e: MouseEvent | TouchEvent) => {
      const src = "touches" in e ? (e.touches[0] ?? e.changedTouches[0]) : e;
      if (!src) return null;
      const r = el.getBoundingClientRect();
      return { x: src.clientX - r.left, y: src.clientY - r.top };
    };
    const inMain = (p: { x: number; y: number }) => {
      const c = chart.current;
      return !!c && p.x >= 0 && p.x <= c.timeScale().width() && p.y >= 0 && p.y <= (c.panes()[0]?.getHeight() ?? 0);
    };
    const stop = (e: Event) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    };
    let drag: { id: string; part: Part; from: Anchor; orig: Drawing } | null = null;
    let placing: { x: number; y: number; pressed: boolean } | null = null;

    const down = (e: MouseEvent | TouchEvent) => {
      if ("button" in e && e.button !== 0) return;
      const L = layer.current;
      const p = pt(e);
      if (!L || !p) return;
      const t = toolRef.current;
      if (!inMain(p)) {
        // Drawings live on the price pane; a click elsewhere just drops the selection.
        if (t === "cursor" && L.selected) h.select(null);
        return;
      }
      if (t !== "cursor") {
        stop(e);
        const a = h.anchorAt(p.x, p.y);
        if (!a) return;
        if (t === "hline") return h.finish({ id: newId(), kind: "hline", a, color: "primary", width: 1.5 });
        if (!L.draft) {
          L.draft = { id: newId(), kind: t, a, b: a, color: "primary", width: 1.5 };
          placing = { ...p, pressed: true };
          L.update();
        } else {
          L.draft.b = a;
          placing = null;
          h.finish(L.draft);
        }
        return;
      }
      const hit = hitTest(L.drawings, L.selected, h.mapper, p.x, p.y);
      if (!hit) {
        if (L.selected) h.select(null);
        return;
      }
      stop(e);
      h.select(hit.id);
      const d = L.drawings.find((x) => x.id === hit.id);
      const from = h.anchorAt(p.x, p.y, false);
      if (d && !d.locked && from) drag = { id: d.id, part: hit.part, from, orig: structuredClone(d) };
    };

    const move = (e: MouseEvent | TouchEvent) => {
      const L = layer.current;
      if (!L) return;
      if (drag) {
        stop(e);
        const p = pt(e);
        const d = L.drawings.find((x) => x.id === drag!.id);
        if (!p || !d) return;
        if (drag.part === "body") {
          const cur = h.anchorAt(p.x, p.y, false);
          if (!cur) return;
          const dt = cur.t - drag.from.t;
          const dp = cur.p - drag.from.p;
          d.a = { t: drag.orig.a.t + dt, p: drag.orig.a.p + dp };
          if (drag.orig.b) d.b = { t: drag.orig.b.t + dt, p: drag.orig.b.p + dp };
        } else {
          const cur = h.anchorAt(p.x, p.y);
          if (cur) d[drag.part] = cur;
        }
        L.update();
        bump();
        return;
      }
      if (L.draft) {
        const p = pt(e);
        if (placing?.pressed) stop(e);
        const cur = p && h.anchorAt(p.x, p.y);
        if (cur) {
          L.draft.b = cur;
          L.update();
        }
      }
    };

    const up = (e: MouseEvent | TouchEvent) => {
      const L = layer.current;
      if (drag) {
        drag = null;
        if (L) h.commit(L.drawings);
        return;
      }
      if (L?.draft && placing?.pressed) {
        placing.pressed = false;
        const p = pt(e);
        // Press-and-drag places both points in one gesture; a plain click waits for the second click.
        if (p && Math.hypot(p.x - placing.x, p.y - placing.y) > 6) {
          placing = null;
          h.finish(L.draft);
        }
      }
    };

    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const L = layer.current;
      if (!L) return;
      if (e.key === "Escape") {
        placing = null;
        if (L.draft) {
          L.draft = null;
          L.update();
        }
        toolRef.current = "cursor";
        setToolState("cursor");
        h.select(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && L.selected) {
        e.preventDefault();
        const id = L.selected;
        h.select(null);
        h.commit(L.drawings.filter((d) => d.id !== id));
      }
    };

    const opts = { capture: true, passive: false } as const;
    el.addEventListener("mousedown", down, true);
    el.addEventListener("touchstart", down, opts);
    el.addEventListener("touchmove", move, opts);
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("touchend", up, true);
    window.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("mousedown", down, true);
      el.removeEventListener("touchstart", down, opts);
      el.removeEventListener("touchmove", move, opts);
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("touchend", up, true);
      window.removeEventListener("keydown", key);
    };
  }, []);

  // Drawings belong to a coin, not a timeframe.
  useEffect(() => {
    const L = layer.current;
    if (!L) return;
    L.drawings = loadDrawings(drawKey);
    L.draft = null;
    select(null);
  }, [drawKey]);

  // Series layout: overlays on the price pane, then indicator panes, then position.
  const subH = isCompact ? 72 : 90;
  const posH = isCompact ? 60 : 80;
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    for (const list of Object.values(extras.current)) for (const s of list ?? []) c.removeSeries(s);
    extras.current = {};
    if (posLine.current) c.removeSeries(posLine.current);
    while (c.panes().length > 1) c.removePane(c.panes().length - 1);

    const keys = layoutKey ? (layoutKey.split(",") as IndKey[]) : [];
    const add = (k: IndKey, s: ISeriesApi<SeriesType>) => (extras.current[k] ??= []).push(s);
    const lineOpts = (color: string, extra: object = {}) => ({ color, lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
    let pane = 1;
    for (const k of keys) {
      if (k === "ma") C.ma.forEach((color) => add(k, c.addSeries(LineSeries, lineOpts(color))));
      if (k === "ema") C.ema.forEach((color) => add(k, c.addSeries(LineSeries, lineOpts(color))));
      if (k === "boll") {
        add(k, c.addSeries(LineSeries, lineOpts(C.boll)));
        add(k, c.addSeries(LineSeries, lineOpts(C.boll, { lineStyle: LineStyle.Dashed })));
        add(k, c.addSeries(LineSeries, lineOpts(C.boll)));
      }
      if (k === "vol") {
        add(k, c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }));
        c.priceScale("vol", 0).applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      }
      if (k === "macd") {
        add(k, c.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane));
        add(k, c.addSeries(LineSeries, lineOpts(C.dif), pane));
        add(k, c.addSeries(LineSeries, lineOpts(C.dea), pane));
        pane++;
      }
      if (k === "rsi") {
        const s = c.addSeries(LineSeries, lineOpts(C.rsi, { lastValueVisible: true }), pane);
        for (const v of [70, 30]) s.createPriceLine({ price: v, color: palette().border, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
        add(k, s);
        pane++;
      }
    }
    posLine.current = c.addSeries(LineSeries, { color: palette().primary, lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceFormat: { type: "volume" } }, pane);
    // Stretch factors keep the proportions when the container grows with each indicator pane.
    const ps = c.panes();
    ps.forEach((p, i) => p.setStretchFactor(i === 0 ? height - posH : i === ps.length - 1 ? posH : subH));
  }, [layoutKey, subH, posH, height]);

  // Pane tops for the per-pane legends; the chart re-lays out after the box resizes.
  useEffect(() => {
    const c = chart.current;
    const el = box.current;
    if (!c || !el) return;
    let timer = 0;
    const measure = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        let y = 0;
        const tops = c.panes().map((p) => {
          const top = y;
          y += p.getHeight() + 1;
          return top;
        });
        setPaneTops((old) => (old.length === tops.length && old.every((v, i) => v === tops[i]) ? old : tops));
      }, 30);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, [layoutKey, subH, posH, height]);

  const calc = useMemo(() => {
    const cl = candles.map((k) => k.c);
    return {
      ma: [sma(cl, 7), sma(cl, 25), sma(cl, 60)],
      ema: [ema(cl, 12), ema(cl, 26)],
      boll: boll(cl),
      macd: macd(cl),
      rsi: rsi(cl),
    };
  }, [candles]);

  // Position and average as of each bar's close.
  const track = useMemo(() => {
    const step = STEP[interval];
    const sizes: number[] = [];
    const avgs: (number | null)[] = [];
    let i = 0;
    let cur: ReplayedFill | null = null;
    for (const k of candles) {
      while (i < fills.length && fills[i].ts < k.t + step) cur = fills[i++];
      const size = cur?.pos ?? 0;
      sizes.push(size);
      avgs.push(cur && Math.abs(size) > 1e-12 ? cur.avg : null);
    }
    return { sizes, avgs };
  }, [candles, fills, interval]);

  // Data.
  useEffect(() => {
    const c = chart.current;
    if (!c || !price.current || !avgLine.current || !posLine.current || !markers.current) return;
    const p = palette();
    price.current.setData(candles.map((k) => ({ time: local(k.t), open: k.o, high: k.h, low: k.l, close: k.c })));
    avgLine.current.setData(line(candles, track.avgs));
    posLine.current.applyOptions({ color: p.primary });
    posLine.current.setData(candles.map((k, i) => ({ time: local(k.t), value: track.sizes[i], color: track.sizes[i] > 0 ? p.up : track.sizes[i] < 0 ? p.down : p.muted })));

    const ex = extras.current;
    ex.ma?.forEach((s, j) => s.setData(line(candles, calc.ma[j])));
    ex.ema?.forEach((s, j) => s.setData(line(candles, calc.ema[j])));
    if (ex.boll) [calc.boll.up, calc.boll.mid, calc.boll.dn].forEach((v, j) => ex.boll![j].setData(line(candles, v)));
    ex.vol?.[0].setData(candles.map((k) => ({ time: local(k.t), value: k.v ?? 0, color: (k.c >= k.o ? p.up : p.down) + "55" })));
    if (ex.macd) {
      ex.macd[0].setData(candles.map((k, i) => (calc.macd.hist[i] == null ? { time: local(k.t) } : { time: local(k.t), value: calc.macd.hist[i]!, color: (calc.macd.hist[i]! >= 0 ? p.up : p.down) + "b3" })));
      ex.macd[1].setData(line(candles, calc.macd.dif));
      ex.macd[2].setData(line(candles, calc.macd.dea));
    }
    ex.rsi?.[0].setData(line(candles, calc.rsi));

    const m = markers.current;
    drawMarkers.current = () => m.setMarkers(buildMarkers(candles, fills, selected, bucket.current, palette()));
    drawMarkers.current();

    if (avgPrice.current) price.current.removePriceLine(avgPrice.current);
    avgPrice.current = Math.abs(pos) > 1e-12 && avg > 0 ? price.current.createPriceLine({ price: avg, color: p.avg, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: trNow("均价", "Avg") }) : null;
    layer.current?.update();

    // Fit only when the dataset changes identity, not on every refetch.
    const key = `${viewKey}:${candles.length > 0}`;
    if (key !== fitKey.current) {
      fitKey.current = key;
      c.timeScale().fitContent();
    }
  }, [candles, fills, avg, pos, selected, viewKey, layoutKey, calc, track, themeTick]);

  // ---- Overlays ----
  const n = candles.length;
  const bi = hover != null && hover >= 0 && hover < n ? hover : n - 1;
  const k = n ? candles[bi] : null;
  const prev = bi > 0 ? candles[bi - 1].c : k?.o;
  const chg = k && prev ? ((k.c - prev) / prev) * 100 : 0;
  const dir = k ? (k.c >= (prev ?? k.o) ? "text-success" : "text-danger") : "";
  const fmt = (v: number | null | undefined) => (v == null ? "—" : fmtPrice(v));
  const fmtSmall = (v: number | null | undefined) => (v == null ? "—" : num(v, Math.abs(v) >= 100 ? 1 : 3));

  const L = layer.current;
  const selD = sel && L ? L.drawings.find((d) => d.id === sel) : undefined;
  let tb: { left: number; top: number } | null = null;
  if (selD && chart.current) {
    const hs = handles(selD, mapper);
    if (hs.length) {
      const x = hs.reduce((a, h) => a + h.x, 0) / hs.length;
      const y = Math.min(...hs.map((h) => h.y));
      const w = mapper.width();
      tb = { left: Math.max(4, Math.min(x - 90, w - 220)), top: Math.max(4, y - 44) };
    }
  }
  const patch = (fn: (d: Drawing) => void) => {
    if (!L || !selD) return;
    fn(selD);
    commit([...L.drawings]);
  };
  const kindLabel = (kd: DrawKind) => (kd === "hline" ? tr("水平线", "Horizontal") : kd === "trend" ? tr("趋势线", "Trend line") : tr("射线", "Ray"));

  const tools: { t: Tool; icon: ReactNode; label: string }[] = [
    { t: "cursor", icon: <MousePointer2 size={16} />, label: tr("光标", "Cursor") },
    { t: "hline", icon: <Minus size={16} />, label: tr("水平线", "Horizontal") },
    { t: "trend", icon: <TrendingUp size={16} />, label: tr("趋势线", "Trend line") },
    { t: "ray", icon: <MoveUpRight size={16} />, label: tr("射线", "Ray") },
  ];
  const clearAll = () => {
    if (!L?.drawings.length) return;
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    select(null);
    commit([]);
  };
  const toolBtn = "flex shrink-0 items-center justify-center gap-1.5 rounded-md text-xs text-muted-fg transition-colors hover:bg-muted hover:text-fg";
  const toolSize = isCompact ? "h-11 w-11" : "h-7 px-2";
  const drawn = (L?.drawings.length ?? 0) > 0;

  const indRows = (
    <>
      <div className="px-3.5 py-1.5 text-xs text-muted-fg">{tr("主图叠加", "Overlays")}</div>
      {OVERLAYS.map((key) => (
        <IndRow key={key} k={key} on={on(key)} onToggle={() => toggleInd(key)} tall={isCompact} />
      ))}
      <div className="my-1.5 h-px bg-border" />
      <div className="px-3.5 py-1.5 text-xs text-muted-fg">{isCompact ? tr("副图（最多 1 个）", "Panes (max 1)") : tr("副图（最多 2 个）", "Panes (max 2)")}</div>
      {SUBS.map((key) => (
        <IndRow key={key} k={key} on={on(key)} onToggle={() => toggleInd(key)} tall={isCompact} />
      ))}
    </>
  );
  const enabled = [...OVERLAYS.filter((x) => ind.includes(x)), ...subs];

  return (
    <div>
      <div className="relative z-10 flex items-center justify-between gap-2 border-b border-border px-2 py-1.5 md:px-3">
        <div className="flex min-w-0 items-center gap-0.5">
          {tools.map(({ t, icon, label }) => (
            <button key={t} type="button" title={label} aria-label={label} aria-pressed={tool === t} onClick={() => setTool(tool === t && t !== "cursor" ? "cursor" : t)} className={clsx(toolBtn, toolSize, tool === t && "bg-primary-soft text-fg hover:bg-primary-soft")}>
              {icon}
              {isCompact ? null : <span>{label}</span>}
            </button>
          ))}
          {isCompact ? null : (
            <>
              <span className="mx-1.5 h-4 w-px bg-border" />
              <button type="button" title={tr("吸附到开高低收", "Snap to OHLC")} aria-pressed={magnet} onClick={() => setMagnet(!magnet)} className={clsx(toolBtn, toolSize, magnet && "bg-primary-soft text-fg hover:bg-primary-soft")}>
                <Magnet size={16} className={magnet ? "text-primary" : undefined} />
                <span>{tr("磁吸", "Magnet")}</span>
              </button>
            </>
          )}
          <button type="button" title={tr("清除画线", "Clear drawings")} aria-label={tr("清除画线", "Clear drawings")} disabled={!drawn} onClick={clearAll} className={clsx(toolBtn, toolSize, "disabled:opacity-40 disabled:hover:bg-transparent", confirmClear && "bg-danger-soft text-danger hover:bg-danger-soft hover:text-danger")}>
            <Trash2 size={16} />
            {isCompact ? null : <span>{confirmClear ? tr("确认清除", "Confirm") : tr("清除画线", "Clear")}</span>}
          </button>
        </div>
        <div className="relative flex items-center gap-2">
          {isCompact ? null : (
            <div className="flex items-center gap-1 max-lg:hidden">
              {enabled.map((key) => (
                <span key={key} className="flex h-6 items-center gap-1 rounded-md border border-border pr-1 pl-2 font-mono text-xs text-fg">
                  {CHIP[key]}
                  <button type="button" aria-label={tr("移除", "Remove")} onClick={() => toggleInd(key)} className="text-muted-fg hover:text-fg">
                    <X size={14} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <button type="button" aria-expanded={menu} onClick={() => setMenu(!menu)} className={clsx("flex items-center gap-1.5 rounded-md bg-muted px-2.5 text-xs text-fg", isCompact ? "h-8" : "h-7")}>
            <ChartLine size={16} />
            {tr("指标", "Indicators")}
            {isCompact ? <span className="text-muted-fg">{enabled.length}</span> : <ChevronDown size={14} className="text-muted-fg" />}
          </button>
          {menu && !isCompact ? (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div className="absolute top-full right-0 z-20 mt-1.5 w-[280px] rounded-lg border border-border bg-card py-2 shadow-[0_8px_28px_rgba(0,0,0,0.45)]">{indRows}</div>
            </>
          ) : null}
        </div>
      </div>

      <div className="relative">
        <div ref={box} style={{ height: height + subs.length * subH }} className={clsx("w-full", tool !== "cursor" && "[&_*]:cursor-crosshair!")} />

        {k ? (
          <div className="pointer-events-none absolute top-1.5 right-[72px] left-2 z-[1] flex flex-col font-mono text-xs leading-normal md:left-3">
            <div className="flex flex-wrap gap-x-2.5 text-muted-fg">
              <span>
                {tr("开", "O")} {fmt(k.o)}
              </span>
              <span>
                {tr("高", "H")} {fmt(k.h)}
              </span>
              {isCompact ? null : (
                <span>
                  {tr("低", "L")} {fmt(k.l)}
                </span>
              )}
              <span className={dir}>
                {tr("收", "C")} {fmt(k.c)}
              </span>
              <span className={dir}>
                {chg >= 0 ? "+" : ""}
                {num(chg, 2)}%
              </span>
              {isCompact || !on("vol") ? null : (
                <span>
                  {tr("量", "V")} {compact(k.v ?? 0)}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-x-2.5">
              {on("ma")
                ? (["MA7", "MA25", "MA60"] as const).map((l, j) => (
                    <span key={l} style={{ color: C.ma[j] }}>
                      {l} {fmt(calc.ma[j][bi])}
                    </span>
                  ))
                : null}
              {on("ema")
                ? (["EMA12", "EMA26"] as const).map((l, j) => (
                    <span key={l} style={{ color: C.ema[j] }}>
                      {l} {fmt(calc.ema[j][bi])}
                    </span>
                  ))
                : null}
              {on("boll") ? (
                <span style={{ color: C.boll }}>
                  BOLL {fmt(calc.boll.mid[bi])} {fmt(calc.boll.up[bi])} {fmt(calc.boll.dn[bi])}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {k
          ? subs.map((key, j) => (
              <div key={key} style={{ top: (paneTops[j + 1] ?? 0) + 4 }} className="pointer-events-none absolute left-2 z-[1] flex gap-2.5 font-mono text-xs md:left-3">
                {key === "macd" ? (
                  <>
                    <span className="text-muted-fg">MACD 12 26 9</span>
                    <span style={{ color: C.dif }}>DIF {fmtSmall(calc.macd.dif[bi])}</span>
                    <span style={{ color: C.dea }}>DEA {fmtSmall(calc.macd.dea[bi])}</span>
                    <span className={(calc.macd.hist[bi] ?? 0) >= 0 ? "text-success" : "text-danger"}>HIST {fmtSmall(calc.macd.hist[bi])}</span>
                  </>
                ) : (
                  <span style={{ color: C.rsi }}>RSI14 {calc.rsi[bi] == null ? "—" : num(calc.rsi[bi]!, 2)}</span>
                )}
              </div>
            ))
          : null}
        {k && paneTops[subs.length + 1] != null ? (
          <div style={{ top: paneTops[subs.length + 1] + 4 }} className="pointer-events-none absolute left-2 z-[1] flex gap-2.5 text-xs md:left-3">
            <span className="text-muted-fg">{tr("仓位", "Position")}</span>
            <span className={clsx("font-mono", track.sizes[bi] > 0 ? "text-success" : track.sizes[bi] < 0 ? "text-danger" : "text-muted-fg")}>
              {track.sizes[bi] === 0 ? tr("空仓", "Flat") : `${track.sizes[bi] > 0 ? tr("多", "Long") : tr("空", "Short")} ${qty(Math.abs(track.sizes[bi]))}`}
            </span>
          </div>
        ) : null}

        {selD && tb ? (
          <div style={{ left: tb.left, top: tb.top }} className="absolute z-[2] flex items-center gap-0.5 rounded-md border border-border bg-muted p-1 shadow-[0_4px_16px_rgba(0,0,0,0.35)]" onMouseDown={(e) => e.stopPropagation()}>
            <span className="px-2 font-mono text-xs whitespace-nowrap text-muted-fg">
              {kindLabel(selD.kind)}
              {selD.kind === "hline" ? ` ${fmt(selD.a.p)}` : ""}
            </span>
            <div className="relative">
              <button type="button" title={tr("颜色", "Color")} onClick={() => setColors(!colors)} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-card">
                <span className="h-3.5 w-3.5 rounded-sm" style={{ background: drawColor(selD.color) }} />
              </button>
              {colors ? (
                <div className="absolute top-full left-0 mt-1 flex gap-1 rounded-md border border-border bg-card p-1.5">
                  {DRAW_COLORS.map((cKey: DrawColor) => (
                    <button key={cKey} type="button" aria-label={cKey} onClick={() => (patch((d) => (d.color = cKey)), setColors(false))} className={clsx("h-5 w-5 rounded-sm ring-offset-1 ring-offset-card", selD.color === cKey && "ring-2 ring-ring")} style={{ background: drawColor(cKey) }} />
                  ))}
                </div>
              ) : null}
            </div>
            <button type="button" title={tr("线宽", "Width")} onClick={() => patch((d) => (d.width = d.width >= 3 ? 1 : d.width >= 2 ? 3 : d.width >= 1.5 ? 2 : 1.5))} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-card">
              <span className="w-3.5 rounded-full bg-fg" style={{ height: Math.max(1, selD.width) }} />
            </button>
            <button type="button" title={selD.locked ? tr("解锁", "Unlock") : tr("锁定", "Lock")} onClick={() => patch((d) => (d.locked = !d.locked))} className={clsx("flex h-7 w-7 items-center justify-center rounded-md hover:bg-card", selD.locked ? "text-primary" : "text-muted-fg")}>
              {selD.locked ? <Lock size={16} /> : <LockOpen size={16} />}
            </button>
            <button
              type="button"
              title={tr("删除", "Delete")}
              onClick={() => {
                const id = selD.id;
                select(null);
                commit((L?.drawings ?? []).filter((d) => d.id !== id));
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-fg hover:bg-danger-soft hover:text-danger"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ) : null}
      </div>

      {menu && isCompact ? (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMenu(false)} />
          <div className="relative rounded-t-xl bg-card pt-2 pb-[max(16px,env(safe-area-inset-bottom))]">
            <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-border" />
            <div className="flex items-center justify-between px-4 pb-2">
              <span className="font-medium text-fg">{tr("指标", "Indicators")}</span>
              <button type="button" aria-label={tr("关闭", "Close")} onClick={() => setMenu(false)} className="flex h-11 w-11 items-center justify-center text-muted-fg">
                <X size={18} />
              </button>
            </div>
            {indRows}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function IndRow({ k, on, onToggle, tall }: { k: IndKey; on: boolean; onToggle: () => void; tall: boolean }) {
  const tr = useTr();
  const [zh, en, params] = IND_LABEL[k];
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={onToggle} className={clsx("flex w-full items-center gap-2.5 px-3.5 text-left hover:bg-muted", tall ? "h-11" : "h-9")}>
      <span className={clsx("flex h-4 w-4 shrink-0 items-center justify-center rounded-[2px] border", on ? "border-primary text-primary" : "border-input")}>{on ? <Check size={12} strokeWidth={3} /> : null}</span>
      <span className="flex-1 text-sm text-fg">{tr(zh, en)}</span>
      <span className="font-mono text-xs text-muted-fg">{k === "vol" ? tr("叠加底部", "overlay") : params}</span>
    </button>
  );
}
