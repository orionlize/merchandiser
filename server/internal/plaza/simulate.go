package plaza

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/util"
)

// 跟单模拟: replays a wallet's public fills over a window as a follower with
// a given capital would have copied them: target = source position × capital
// ÷ source equity, changes under the venue minimum skipped (and carried),
// fills at the source's price plus slippage, taker fees. Coins the wallet
// already held when the window opened are left alone until it is flat on
// them, like the "new positions only" start policy.

const (
	takerFee   = 0.00045
	minOrder   = 10.0 // USDT, Hyperliquid's minimum order value
	simTTL     = 5 * time.Minute
	fillsPage  = 2000
	maxPages   = 5
	curvePoint = 120
)

type simFill struct {
	t     int64
	coin  string
	start float64
	sz    float64 // signed: + bought
	px    float64
}

type simData struct {
	at        time.Time
	from      int64
	fills     []simFill
	av, pnl   [][2]float64
	mids      map[string]float64
	truncated bool
}

type SimCoin struct {
	Coin   string  `json:"coin"`
	Trades int     `json:"trades"`
	Pnl    float64 `json:"pnl"`
}

type SimResult struct {
	Window  string  `json:"window"`
	From    int64   `json:"from"`
	To      int64   `json:"to"`
	Capital float64 `json:"capital"`
	SlipBps float64 `json:"slip_bps"`
	// Net of fees and slippage, open positions marked at current mids.
	Pnl        float64  `json:"pnl"`
	Roi        float64  `json:"roi"`
	TraderRoi  float64  `json:"trader_roi"`
	Efficiency *float64 `json:"efficiency"`
	MaxDD      float64  `json:"max_dd"`
	Trades     int      `json:"trades"`
	Skipped    int      `json:"skipped"`
	Considered int      `json:"considered"`
	Fees       float64  `json:"fees"`
	SlipCost   float64  `json:"slip_cost"`
	// new_only | sync_existing
	Start string `json:"start"`
	// Held when the window opened: not followed until flat (new_only).
	Ignored []string `json:"ignored"`
	// Held when the window opened and copied at the first price seen
	// (sync_existing).
	Synced []string `json:"synced"`
	// Builder-deployed (HIP-3) perps such as "xyz:ANT": the engine only
	// trades the main perp dex, so these are left out of the replay.
	Unsupported []string  `json:"unsupported"`
	Coins       []SimCoin `json:"coins"`
	// [ts, simulated PnL, trader's PnL scaled to the capital]
	Curve [][3]float64 `json:"curve"`
	// Capital at which most skipped changes would have been placed.
	SuggestCapital *float64 `json:"suggest_capital"`
	// Fills were capped (very active wallet): the window starts at From.
	Truncated bool `json:"truncated"`
}

var simDays = map[string]int{"7d": 7, "30d": 30}

// simEntry is one wallet's cached inputs, shared by both windows: the 7-day
// view is a slice of the 30-day one, and asking for 30 days after 7 only
// fetches the older fills.
type simEntry struct {
	at    time.Time
	av    map[string][][2]float64 // by window
	pnl   map[string][][2]float64
	from  int64     // fills are complete from here up to `at`
	fills []simFill // ascending
	pages int
	// HL only serves a wallet's 10,000 most recent fills; nothing before
	// `from` can be fetched.
	capped bool
	mids   map[string]float64
}

func (e *simEntry) view(win string) *simData {
	want := e.at.UnixMilli() - int64(simDays[win])*86_400_000
	from := max(want, e.from)
	i := sort.Search(len(e.fills), func(i int) bool { return e.fills[i].t >= from })
	return &simData{at: e.at, from: from, fills: e.fills[i:], av: e.av[win], pnl: e.pnl[win], mids: e.mids, truncated: from > want}
}

// fetchFills pages userFillsByTime ascending over [start, end] (end 0 =
// now). done is false when the page budget ran out before the range did.
func (s *Service) fetchFills(ctx context.Context, addr string, start, end int64, pages int) (fills []simFill, used int, done bool, err error) {
	seen := map[string]bool{}
	for used < pages {
		body := map[string]any{"type": "userFillsByTime", "user": addr, "startTime": start, "aggregateByTime": true}
		if end > 0 {
			body["endTime"] = end
		}
		fj, err := s.hl.PublicInfo(ctx, body, 20, s.sim)
		if err != nil {
			return nil, used, false, err
		}
		used++
		arr := fj.Arr()
		// HL charges one more weight per 20 fills returned.
		if extra := float64(len(arr) / 20); extra > 0 {
			_ = s.sim.Acquire(ctx, extra, false)
		}
		last := start
		for _, f := range arr {
			t, _ := f.Get("time").Int()
			last = max(last, t)
			coin := f.JStr("coin")
			// Perps only: spot fills are "@123" or "PURR/USDC".
			if coin == "" || strings.HasPrefix(coin, "@") || strings.Contains(coin, "/") {
				continue
			}
			sz := f64(f.Get("sz"))
			if f.JStr("side") != "B" {
				sz = -sz
			}
			id := fmt.Sprintf("%d|%s|%v|%v", t, coin, sz, f64(f.Get("px")))
			if seen[id] {
				continue
			}
			seen[id] = true
			fills = append(fills, simFill{t: t, coin: coin, start: f64(f.Get("startPosition")), sz: sz, px: f64(f.Get("px"))})
		}
		if len(arr) < fillsPage {
			done = true
			break
		}
		start = last + 1
	}
	sort.SliceStable(fills, func(i, j int) bool { return fills[i].t < fills[j].t })
	return fills, used, done, nil
}

func (s *Service) simData(ctx context.Context, addr, win string) (*simData, error) {
	s.simMu.Lock()
	e, ok := s.simCache[addr]
	if ok && time.Since(e.at) >= simTTL {
		ok = false
	}
	s.simMu.Unlock()
	if ok {
		want := e.at.UnixMilli() - int64(simDays[win])*86_400_000
		if e.from <= want || e.capped || e.pages >= maxPages {
			return e.view(win), nil
		}
		// Extend back to the longer window. If the page budget runs out
		// first, keep what we have: a gap in the middle would break the
		// replay, so a shorter but contiguous history is the better answer.
		older, used, done, err := s.fetchFills(ctx, addr, want, e.from-1, maxPages-e.pages)
		if err != nil {
			return nil, err
		}
		ext := *e
		ext.pages += used
		if done {
			ext.fills = append(older, e.fills...)
			ext.from = want
		} else {
			ext.capped = true
		}
		s.putSim(addr, &ext)
		return ext.view(win), nil
	}

	at := time.Now()
	e = &simEntry{at: at, av: map[string][][2]float64{}, pnl: map[string][][2]float64{}, mids: map[string]float64{}}
	e.from = at.UnixMilli() - int64(simDays[win])*86_400_000
	pf, err := s.hl.PublicInfo(ctx, map[string]any{"type": "portfolio", "user": addr}, 20, s.sim)
	if err != nil {
		return nil, err
	}
	for _, pair := range pf.Arr() {
		for w, name := range hlWindow {
			if pair.At(0).Str() == name {
				e.av[w] = series(pair.At(1).Get("accountValueHistory"))
				e.pnl[w] = series(pair.At(1).Get("pnlHistory"))
			}
		}
	}
	fills, used, done, err := s.fetchFills(ctx, addr, e.from, 0, maxPages)
	if err != nil {
		return nil, err
	}
	e.fills, e.pages = fills, used
	// Out of pages means HL's fill history ran out (5 × 2,000 is its
	// 10,000-fill limit): the pages run up to now, so the history is
	// complete from the first fill on.
	if !done {
		e.capped = true
		if len(fills) > 0 {
			e.from = max(e.from, fills[0].t)
		}
	}
	if mids, err := s.hl.PublicInfo(ctx, map[string]any{"type": "allMids"}, 2, s.sim); err == nil {
		for k, v := range mids.Obj() {
			e.mids[k] = f64(v)
		}
	}
	s.putSim(addr, e)
	return e.view(win), nil
}

func (s *Service) putSim(addr string, e *simEntry) {
	s.simMu.Lock()
	defer s.simMu.Unlock()
	s.simCache[addr] = e
	for k, v := range s.simCache {
		if time.Since(v.at) > simTTL {
			delete(s.simCache, k)
		}
	}
}

// at returns the series value at or before t (the first one before it starts).
func at(p [][2]float64, t int64) float64 {
	if len(p) == 0 {
		return 0
	}
	i := sort.Search(len(p), func(i int) bool { return p[i][0] > float64(t) })
	if i == 0 {
		return p[0][1]
	}
	return p[i-1][1]
}

type simPos struct{ size, avg float64 }

// Simulate runs the follow simulation for one wallet.
func (s *Service) Simulate(ctx context.Context, addr, win, start string, capital, slipBps float64) (*SimResult, error) {
	s.Touch()
	if _, ok := simDays[win]; !ok {
		return nil, errs.Msg("模拟区间应为 7 天或 30 天")
	}
	if capital < minOrder || capital > 1e9 {
		return nil, errs.Msg("模拟本金应在 10 USDT 以上")
	}
	if slipBps < 0 || slipBps > 500 {
		return nil, errs.Msg("滑点应在 0–500 bps 之间")
	}
	if start == "" {
		start = "new_only"
	}
	if start != "new_only" && start != "sync_existing" {
		return nil, errs.Msg("未知的起始持仓方式")
	}
	d, err := s.simData(ctx, strings.ToLower(addr), win)
	if err != nil {
		return nil, err
	}
	return simulate(d, win, start, capital, slipBps, util.NowMs()), nil
}

func simulate(d *simData, win, start string, capital, slipBps float64, now int64) *SimResult {
	const eps = 1e-12
	slip := slipBps / 10_000
	sync := start == "sync_existing"
	res := &SimResult{Window: win, Start: start, From: d.from, To: now, Capital: capital, SlipBps: slipBps, Ignored: []string{}, Synced: []string{}, Unsupported: []string{}, Coins: []SimCoin{}, Curve: [][3]float64{}}
	started, ignored, unsupported := map[string]bool{}, map[string]bool{}, map[string]bool{}
	pos, lastPx := map[string]*simPos{}, map[string]float64{}
	coins := map[string]*SimCoin{}
	realized, fees := 0.0, 0.0
	var need []float64
	av0, pnl0 := at(d.av, d.from), at(d.pnl, d.from)
	traderAt := func(t int64) float64 {
		if av0 <= 0 {
			return 0
		}
		return (at(d.pnl, t) - pnl0) / av0 * capital
	}
	mark := func() float64 {
		u := 0.0
		for c, p := range pos {
			if p.size != 0 {
				u += p.size * (lastPx[c] - p.avg)
			}
		}
		return realized - fees + u
	}
	peak, dd := 0.0, 0.0
	var curve [][3]float64
	point := func(t int64) {
		v := mark()
		peak = math.Max(peak, v)
		if eq := capital + peak; eq > 0 {
			dd = math.Max(dd, (peak-v)/eq)
		}
		curve = append(curve, [3]float64{float64(t), v, traderAt(t)})
	}
	curve = append(curve, [3]float64{float64(d.from), 0, 0})
	// sync_existing: a coin held when the window opened is bought in at the
	// first price seen, sized against the trader's equity at the start.
	openHeld := func(c string, f simFill) {
		srcEq := at(d.av, d.from)
		if srcEq <= 0 {
			return
		}
		target := f.start * capital / srcEq
		if math.Abs(target)*f.px < minOrder {
			res.Skipped++
			return
		}
		px := f.px * (1 + slip)
		if target < 0 {
			px = f.px * (1 - slip)
		}
		fee := math.Abs(target) * px * takerFee
		fees += fee
		res.Fees += fee
		res.SlipCost += math.Abs(target) * f.px * slip
		pos[c] = &simPos{size: target, avg: px}
		cs := &SimCoin{Coin: c, Trades: 1, Pnl: -fee}
		coins[c] = cs
		res.Trades++
		res.Synced = append(res.Synced, c)
	}
	for _, f := range d.fills {
		c := f.coin
		if strings.Contains(c, ":") {
			unsupported[c] = true
			continue
		}
		end := f.start + f.sz
		lastPx[c] = f.px
		if !started[c] {
			started[c] = true
			if math.Abs(f.start) > eps {
				if sync {
					openHeld(c, f)
				} else {
					ignored[c] = true
				}
			}
		}
		if ignored[c] {
			flat := math.Abs(end) < eps
			flipped := !flat && (end > 0) != (f.start > 0)
			if !flat && !flipped {
				continue
			}
			delete(ignored, c)
			if flat {
				continue
			}
		}
		res.Considered++
		srcEq := at(d.av, f.t)
		if srcEq <= 0 {
			continue
		}
		p := pos[c]
		if p == nil {
			p = &simPos{}
			pos[c] = p
		}
		target := end * capital / srcEq
		if math.Abs(end) < eps {
			target = 0
		}
		delta := target - p.size
		if math.Abs(delta) < eps {
			continue
		}
		fullClose := target == 0 && p.size != 0
		notional := math.Abs(delta) * f.px
		if !fullClose && notional < minOrder {
			res.Skipped++
			if notional > 0 {
				need = append(need, capital*minOrder/notional)
			}
			continue
		}
		px := f.px * (1 + slip)
		if delta < 0 {
			px = f.px * (1 - slip)
		}
		fee := math.Abs(delta) * px * takerFee
		fees += fee
		res.Fees += fee
		res.SlipCost += math.Abs(delta) * f.px * slip
		cs := coins[c]
		if cs == nil {
			cs = &SimCoin{Coin: c}
			coins[c] = cs
		}
		cs.Trades++
		cs.Pnl -= fee
		// Average-cost booking, flipping through zero.
		if p.size == 0 || (p.size > 0) == (delta > 0) {
			tot := math.Abs(p.size) + math.Abs(delta)
			p.avg = (math.Abs(p.size)*p.avg + math.Abs(delta)*px) / tot
			p.size += delta
		} else {
			closed := math.Min(math.Abs(delta), math.Abs(p.size))
			sign := 1.0
			if p.size < 0 {
				sign = -1
			}
			r := closed * (px - p.avg) * sign
			realized += r
			cs.Pnl += r
			p.size += delta
			if math.Abs(p.size) < eps {
				p.size, p.avg = 0, 0
			} else if (p.size > 0) != (sign > 0) {
				p.avg = px
			}
		}
		res.Trades++
		point(f.t)
	}
	// Mark what is still open at current mids.
	for c, p := range pos {
		if p.size == 0 {
			continue
		}
		if m, ok := d.mids[c]; ok && m > 0 {
			lastPx[c] = m
		}
		if cs := coins[c]; cs != nil {
			cs.Pnl += p.size * (lastPx[c] - p.avg)
		}
	}
	point(now)
	res.Pnl = mark()
	res.Roi = res.Pnl / capital
	res.MaxDD = dd
	if av0 > 0 {
		res.TraderRoi = (at(d.pnl, now) - pnl0) / av0
	}
	// Nothing copyable (every coin held from before, or HIP-3 only): no
	// efficiency to speak of.
	if res.TraderRoi > 0 && res.Considered > 0 {
		e := res.Roi / res.TraderRoi
		res.Efficiency = &e
	}
	res.Truncated = d.truncated
	for c := range ignored {
		res.Ignored = append(res.Ignored, c)
	}
	sort.Strings(res.Ignored)
	for c := range unsupported {
		res.Unsupported = append(res.Unsupported, c)
	}
	sort.Strings(res.Unsupported)
	for _, cs := range coins {
		res.Coins = append(res.Coins, *cs)
	}
	sort.Slice(res.Coins, func(i, j int) bool { return res.Coins[i].Trades > res.Coins[j].Trades })
	if len(need) > 0 {
		sort.Float64s(need)
		v := need[min(len(need)-1, int(float64(len(need))*0.8))]
		step := math.Pow(10, math.Floor(math.Log10(v)))
		v = math.Ceil(v/(step/2)) * (step / 2)
		if v > capital {
			res.SuggestCapital = &v
		}
	}
	res.Curve = thin(curve, curvePoint)
	return res
}

// thin keeps n evenly spaced points, always including the last.
func thin(p [][3]float64, n int) [][3]float64 {
	if len(p) <= n {
		return p
	}
	out := make([][3]float64, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, p[i*(len(p)-1)/(n-1)])
	}
	return out
}
