import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

export type DrawKind = "hline" | "trend" | "ray";
/** A point on the chart: wall-clock ms and price, so drawings survive timeframe switches. */
export interface Anchor {
  t: number;
  p: number;
}
export interface Drawing {
  id: string;
  kind: DrawKind;
  a: Anchor;
  /** Second point; unused for horizontal lines. */
  b?: Anchor;
  color: DrawColor;
  width: number;
  locked?: boolean;
}

export const DRAW_COLORS = ["primary", "cyan", "purple", "up", "down", "fg"] as const;
export type DrawColor = (typeof DRAW_COLORS)[number];

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function drawColor(c: DrawColor) {
  switch (c) {
    case "primary":
      return cssVar("--primary");
    case "cyan":
      return "#3fb6e0";
    case "purple":
      return "#b46be0";
    case "up":
      return cssVar("--success");
    case "down":
      return cssVar("--danger");
    case "fg":
      return cssVar("--fg");
  }
}

/** Converts between anchors and pixel coordinates in the main pane (CSS px). */
export interface Mapper {
  x(t: number): number | null;
  y(p: number): number | null;
  width(): number;
}

export type Part = "a" | "b" | "body";
interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const HANDLE_PX = 7;
const LINE_PX = 5;

/** Screen segment for a drawing; rays and horizontal lines run to the pane edge. */
export function segment(d: Drawing, m: Mapper): Seg | null {
  const w = m.width();
  const ya = m.y(d.a.p);
  if (ya == null) return null;
  if (d.kind === "hline") return { x1: 0, y1: ya, x2: w, y2: ya };
  const xa = m.x(d.a.t);
  const b = d.b ?? d.a;
  const xb = m.x(b.t);
  const yb = m.y(b.p);
  if (xa == null || xb == null || yb == null) return null;
  if (d.kind === "ray" && Math.abs(xb - xa) > 0.5) {
    const xe = xb > xa ? w : 0;
    return { x1: xa, y1: ya, x2: xe, y2: ya + ((yb - ya) * (xe - xa)) / (xb - xa) };
  }
  return { x1: xa, y1: ya, x2: xb, y2: yb };
}

/** Screen positions of a drawing's draggable handles. */
export function handles(d: Drawing, m: Mapper): { part: "a" | "b"; x: number; y: number }[] {
  const out: { part: "a" | "b"; x: number; y: number }[] = [];
  const ya = m.y(d.a.p);
  const xa = d.kind === "hline" ? (m.x(d.a.t) ?? m.width() / 2) : m.x(d.a.t);
  if (xa != null && ya != null) out.push({ part: "a", x: xa, y: ya });
  if (d.kind !== "hline" && d.b) {
    const xb = m.x(d.b.t);
    const yb = m.y(d.b.p);
    if (xb != null && yb != null) out.push({ part: "b", x: xb, y: yb });
  }
  return out;
}

function distToSeg(px: number, py: number, s: Seg) {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = dx * dx + dy * dy;
  const k = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len));
  return Math.hypot(px - (s.x1 + k * dx), py - (s.y1 + k * dy));
}

/** Topmost drawing under the point, preferring the selected one's handles. */
export function hitTest(list: Drawing[], selected: string | null, m: Mapper, x: number, y: number): { id: string; part: Part } | null {
  const sel = list.find((d) => d.id === selected);
  if (sel) for (const h of handles(sel, m)) if (Math.hypot(h.x - x, h.y - y) <= HANDLE_PX) return { id: sel.id, part: sel.kind === "hline" ? "body" : h.part };
  for (let i = list.length - 1; i >= 0; i--) {
    const s = segment(list[i], m);
    if (s && distToSeg(x, y, s) <= LINE_PX) return { id: list[i].id, part: "body" };
  }
  return null;
}

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/**
 * Series primitive that paints user drawings on the main pane and labels
 * horizontal lines on the price axis. State is mutated by the owner, which
 * then calls `update()`.
 */
export class DrawingLayer implements ISeriesPrimitive<Time> {
  drawings: Drawing[] = [];
  selected: string | null = null;
  draft: Drawing | null = null;
  private request = () => {};
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private axis: ISeriesPrimitiveAxisView[] = [];

  constructor(private map: Mapper) {}

  attached(p: SeriesAttachedParameter<Time>) {
    this.request = p.requestUpdate;
    this.series = p.series;
  }
  detached() {
    this.request = () => {};
    this.series = null;
  }
  update() {
    this.request();
  }

  updateAllViews() {
    const fmt = this.series?.priceFormatter();
    this.axis = [...this.drawings, ...(this.draft ? [this.draft] : [])]
      .filter((d) => d.kind === "hline")
      .map((d) => {
        const bg = drawColor(d.color);
        return {
          coordinate: () => this.map.y(d.a.p) ?? -100,
          text: () => (fmt ? fmt.format(d.a.p) : String(d.a.p)),
          textColor: () => (d.color === "fg" ? cssVar("--card") : "#000"),
          backColor: () => bg,
        };
      });
  }
  priceAxisViews() {
    return this.axis;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [{ zOrder: () => "top", renderer: () => ({ draw: (t: Target) => this.draw(t) }) }];
  }

  private draw(target: Target) {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const card = cssVar("--card");
      const all = this.draft ? [...this.drawings, this.draft] : this.drawings;
      for (const d of all) {
        const s = segment(d, this.map);
        if (!s) continue;
        const color = drawColor(d.color);
        const sel = d.id === this.selected || d === this.draft;
        ctx.strokeStyle = color;
        ctx.lineWidth = d.width;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        if (!sel) continue;
        for (const h of handles(d, this.map)) {
          ctx.beginPath();
          ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = card;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    });
  }
}

const KEY = "merchandiser.drawings.";

export function loadDrawings(key: string): Drawing[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY + key) ?? "[]");
    return Array.isArray(v) ? v.filter((d) => d && d.a && typeof d.a.t === "number" && typeof d.a.p === "number") : [];
  } catch {
    return [];
  }
}

export function saveDrawings(key: string, list: Drawing[]) {
  try {
    if (list.length) localStorage.setItem(KEY + key, JSON.stringify(list));
    else localStorage.removeItem(KEY + key);
  } catch {
    /* storage unavailable */
  }
}
