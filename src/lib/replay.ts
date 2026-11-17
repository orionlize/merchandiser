import type { ChartFill } from "./api";

export type FillKind = "open" | "add" | "reduce" | "close" | "flip";

/** One fill with the position it left behind, replayed oldest first. */
export interface ReplayedFill extends ChartFill {
  kind: FillKind;
  /** 1-based count of adds since the position was opened (only for "add"). */
  addNo: number;
  /** Signed size of this fill: buy positive, sell negative. */
  delta: number;
  /** Combined signed position across followers after the fill. */
  pos: number;
  /** Combined average entry price after the fill (0 when flat). */
  avg: number;
  /** Realized PnL booked by this fill, before fees. */
  realized: number;
}

export interface Replay {
  fills: ReplayedFill[];
  pos: number;
  avg: number;
  realized: number;
}

interface Leg {
  pos: number;
  avg: number;
  adds: number;
}

/**
 * Rebuilds size, average entry and realized PnL from fills. Each follower
 * account is replayed on its own (they hold separate positions) and the
 * results are combined: size is summed, average is size-weighted.
 */
export function replay(fills: ChartFill[]): Replay {
  const legs = new Map<string, Leg>();
  const out: ReplayedFill[] = [];
  let realizedTotal = 0;

  const combined = () => {
    let pos = 0;
    let w = 0;
    let wavg = 0;
    for (const l of legs.values()) {
      pos += l.pos;
      w += Math.abs(l.pos);
      wavg += Math.abs(l.pos) * l.avg;
    }
    return { pos, avg: w > 0 ? wavg / w : 0 };
  };

  for (const f of fills) {
    const key = f.connection_id ?? "";
    const leg = legs.get(key) ?? { pos: 0, avg: 0, adds: 0 };
    const q = Number(f.qty);
    const x = Number(f.px);
    if (!Number.isFinite(q) || !Number.isFinite(x) || q === 0) continue;
    const d = f.buy ? q : -q;
    let kind: FillKind;
    let realized = 0;
    let addNo = 0;

    if (leg.pos === 0 || Math.sign(leg.pos) === Math.sign(d)) {
      kind = leg.pos === 0 ? "open" : "add";
      leg.avg = (Math.abs(leg.pos) * leg.avg + q * x) / (Math.abs(leg.pos) + q);
      leg.pos += d;
      if (kind === "open") leg.adds = 0;
      else addNo = ++leg.adds;
    } else {
      const closing = Math.min(q, Math.abs(leg.pos));
      realized = closing * (x - leg.avg) * Math.sign(leg.pos);
      const next = leg.pos + d;
      if (Math.abs(next) < 1e-12) {
        kind = "close";
        leg.pos = 0;
        leg.avg = 0;
        leg.adds = 0;
      } else if (Math.sign(next) !== Math.sign(leg.pos)) {
        kind = "flip";
        leg.pos = next;
        leg.avg = x;
        leg.adds = 0;
      } else {
        kind = "reduce";
        leg.pos = next;
      }
    }
    legs.set(key, leg);
    realizedTotal += realized;
    const c = combined();
    out.push({ ...f, kind, addNo, delta: d, pos: c.pos, avg: c.avg, realized });
  }
  const c = combined();
  return { fills: out, pos: c.pos, avg: c.avg, realized: realizedTotal };
}
