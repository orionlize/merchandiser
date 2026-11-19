/** Technical indicators over closes. Every output is aligned with the input; `null` = not enough history yet. */

export type Series = (number | null)[];

export function sma(xs: number[], n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= n) sum -= xs[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n values. */
export function ema(xs: number[], n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  if (xs.length < n) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) prev += xs[i];
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < xs.length; i++) {
    prev = xs[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function boll(xs: number[], n = 20, mult = 2) {
  const mid = sma(xs, n);
  const up: Series = new Array(xs.length).fill(null);
  const dn: Series = new Array(xs.length).fill(null);
  for (let i = n - 1; i < xs.length; i++) {
    const m = mid[i]!;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (xs[j] - m) ** 2;
    const sd = Math.sqrt(v / n);
    up[i] = m + mult * sd;
    dn[i] = m - mult * sd;
  }
  return { mid, up, dn };
}

export function macd(xs: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(xs, fast);
  const s = ema(xs, slow);
  const dif: Series = xs.map((_, i) => (f[i] != null && s[i] != null ? f[i]! - s[i]! : null));
  const start = dif.findIndex((v) => v != null);
  const dea: Series = new Array(xs.length).fill(null);
  if (start >= 0) {
    const e = ema(dif.slice(start) as number[], signal);
    e.forEach((v, i) => (dea[start + i] = v));
  }
  const hist: Series = dif.map((d, i) => (d != null && dea[i] != null ? d - dea[i]! : null));
  return { dif, dea, hist };
}

/** Wilder's RSI. */
export function rsi(xs: number[], n = 14): Series {
  const out: Series = new Array(xs.length).fill(null);
  if (xs.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = xs[i] - xs[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = val();
  for (let i = n + 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}
