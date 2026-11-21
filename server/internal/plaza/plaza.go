// Package plaza ranks public Hyperliquid wallets by how well they can be
// copied ("跟单适配度"). It reads the public leaderboard, picks candidates,
// then analyses each one (equity/PnL curve, recent fills) at a throttled pace
// so the crawl never competes with live trading for the HL weight budget.
package plaza

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"merchandiser/server/internal/exchange"
	"merchandiser/server/internal/util"
)

const (
	leaderboardURL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
	lbTTL          = 10 * time.Minute
	analysisTTL    = 30 * time.Minute
	idleStop       = time.Hour
	minEquity      = 100_000
)

// Windows in API order; HL names in parentheses.
var Windows = []string{"7d", "30d", "all"}

var hlWindow = map[string]string{"7d": "week", "30d": "month", "all": "allTime"}

type Perf struct {
	Pnl float64 `json:"pnl"`
	Roi float64 `json:"roi"`
	Vlm float64 `json:"vlm"`
}

type Analysis struct {
	At     int64              `json:"at"`
	Equity float64            `json:"equity"`
	MaxDD  map[string]float64 `json:"max_dd"`
	// PnL curve per window: [ts_ms, pnl] (down-sampled).
	Curve map[string][][2]float64 `json:"-"`
	// Share of positive steps on the PnL curve, per window.
	UpShare map[string]float64 `json:"-"`
	// From the last 7 days of fills.
	WinRate      *float64 `json:"win_rate"`
	AvgHoldSec   *float64 `json:"avg_hold_sec"`
	TradesPerDay float64  `json:"trades_per_day"`
	Coins        []string `json:"coins"`
}

type Wallet struct {
	Address     string          `json:"address"`
	DisplayName *string         `json:"display_name"`
	LbEquity    float64         `json:"-"`
	Perf        map[string]Perf `json:"perf"`
	A           *Analysis       `json:"-"`
	Err         string          `json:"-"`
}

type Factors struct {
	DD     float64 `json:"dd"`
	Hold   float64 `json:"hold"`
	Stable float64 `json:"stable"`
	Size   float64 `json:"size"`
}

func clamp01(x float64) float64 { return math.Max(0, math.Min(1, x)) }

// HFT: copy latency (seconds) is comparable to the holding time, or the
// position changes so often that a follower would trade nonstop.
func (a *Analysis) HFT() bool {
	if a == nil || a.AvgHoldSec == nil {
		return false
	}
	h := *a.AvgHoldSec
	return h < 15*60 || a.TradesPerDay > 2000 || (a.TradesPerDay > 500 && h < 2*3600)
}

// Score is the copy-fit score 0–100 for a window: four 0–25 factors, then
// penalties for high-frequency trading and a losing window.
func Score(w *Wallet, win string) (int, Factors) {
	a := w.A
	if a == nil {
		return 0, Factors{}
	}
	var f Factors
	f.DD = 25 * clamp01(1-(a.MaxDD[win]-0.05)/0.35)
	switch {
	case a.AvgHoldSec != nil:
		h := *a.AvgHoldSec / 3600
		f.Hold = 25 * clamp01(math.Log10(math.Max(h, 1e-6)/0.25)/math.Log10(96))
	case len(a.Coins) == 0:
		f.Hold = 10 // inactive: nothing to copy right now
	default:
		f.Hold = 25 // holds positions, no trades this week
	}
	p := w.Perf[win]
	sign := 1.0
	if p.Roi <= 0 {
		sign = 0.3
	}
	f.Stable = 25 * clamp01((a.UpShare[win]-0.3)/0.4) * sign
	f.Size = 25 * clamp01(math.Log10(math.Max(a.Equity, 1)/50_000)/2)
	s := f.DD + f.Hold + f.Stable + f.Size
	if a.HFT() {
		s = math.Min(s*0.4, 30)
	}
	if p.Pnl < 0 {
		s *= 0.6
	}
	return int(math.Round(s)), f
}

// ---------- service ----------

type Service struct {
	root context.Context
	hl   *exchange.Hyperliquid
	// The crawler's budget, and a separate one for wallets the user opens so
	// those never queue behind the crawl. Together a quarter of HL's per-IP budget.
	budget *exchange.TokenBucket
	ui     *exchange.TokenBucket
	lbHTTP *http.Client
	// Addresses always analysed (favourites, followed sources).
	pinned  func(context.Context) []string
	store   Store
	dirty   bool
	savedAt time.Time

	mu       sync.RWMutex
	cands    []string
	wallets  map[string]*Wallet
	lbAt     int64
	lbErr    string
	lbTry    time.Time
	lastUse  time.Time
	running  bool
	priority []string
}

// Store persists the crawl so a restart or deploy doesn't start from an
// empty plaza. Either func may be nil.
type Store struct {
	Load func(context.Context) []byte
	Save func(context.Context, []byte)
}

func New(root context.Context, pinned func(context.Context) []string, st Store) (*Service, error) {
	hl, err := exchange.NewHyperliquidPublic("0x0000000000000000000000000000000000000000", false, "")
	if err != nil {
		return nil, err
	}
	s := &Service{
		root: root, hl: hl, pinned: pinned, store: st,
		budget:  exchange.NewBucket(240, time.Minute),
		ui:      exchange.NewBucket(60, time.Minute),
		lbHTTP:  &http.Client{Timeout: 90 * time.Second},
		wallets: map[string]*Wallet{},
	}
	if st.Load != nil {
		if b := st.Load(root); len(b) > 0 {
			if err := s.restore(b); err != nil {
				slog.Warn("plaza cache", "err", err)
			}
		}
	}
	return s, nil
}

// ---------- persistence ----------

type savedAnalysis struct {
	*Analysis
	Curve   map[string][][2]float64 `json:"curve"`
	UpShare map[string]float64      `json:"up_share"`
}

type savedWallet struct {
	Address     string          `json:"address"`
	DisplayName *string         `json:"display_name"`
	LbEquity    float64         `json:"lb_equity"`
	Perf        map[string]Perf `json:"perf"`
	A           *savedAnalysis  `json:"a"`
}

type snapshot struct {
	V       int           `json:"v"`
	LbAt    int64         `json:"lb_at"`
	Cands   []string      `json:"cands"`
	Wallets []savedWallet `json:"wallets"`
}

const snapVersion = 1

func (s *Service) restore(b []byte) error {
	var sn snapshot
	if err := json.Unmarshal(b, &sn); err != nil {
		return err
	}
	if sn.V != snapVersion {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sw := range sn.Wallets {
		w := &Wallet{Address: sw.Address, DisplayName: sw.DisplayName, LbEquity: sw.LbEquity, Perf: sw.Perf}
		if w.Perf == nil {
			w.Perf = map[string]Perf{}
		}
		if sa := sw.A; sa != nil && sa.Analysis != nil {
			a := *sa.Analysis
			a.Curve, a.UpShare = sa.Curve, sa.UpShare
			w.A = &a
		}
		s.wallets[w.Address] = w
	}
	s.cands, s.lbAt = sn.Cands, sn.LbAt
	return nil
}

// save writes the crawl at most every 30 s (force: now) when it changed.
func (s *Service) save(force bool) {
	if s.store.Save == nil {
		return
	}
	s.mu.Lock()
	if !s.dirty || (!force && time.Since(s.savedAt) < 30*time.Second) {
		s.mu.Unlock()
		return
	}
	sn := snapshot{V: snapVersion, LbAt: s.lbAt, Cands: s.cands}
	for _, w := range s.wallets {
		sw := savedWallet{Address: w.Address, DisplayName: w.DisplayName, LbEquity: w.LbEquity, Perf: w.Perf}
		if w.A != nil {
			sw.A = &savedAnalysis{Analysis: w.A, Curve: w.A.Curve, UpShare: w.A.UpShare}
		}
		sn.Wallets = append(sn.Wallets, sw)
	}
	b, err := json.Marshal(sn)
	s.dirty, s.savedAt = false, time.Now()
	s.mu.Unlock()
	if err != nil {
		slog.Warn("plaza cache", "err", err)
		return
	}
	s.store.Save(s.root, b)
}

// Touch records use and starts the crawler if it is idle.
func (s *Service) Touch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastUse = time.Now()
	if !s.running {
		s.running = true
		go s.loop()
	}
}

type Status struct {
	UpdatedAt int64  `json:"updated_at"`
	Analyzed  int    `json:"analyzed"`
	Total     int    `json:"total"`
	Error     string `json:"error,omitempty"`
}

// List returns candidates and pinned wallets plus crawl status.
func (s *Service) List(ctx context.Context) ([]Wallet, Status) {
	s.Touch()
	pins := s.pinned(ctx)
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := map[string]bool{}
	out := []Wallet{}
	st := Status{UpdatedAt: s.lbAt, Error: s.lbErr}
	add := func(a string) {
		if seen[a] {
			return
		}
		seen[a] = true
		w := s.wallets[a]
		if w == nil {
			w = &Wallet{Address: a, Perf: map[string]Perf{}}
		}
		out = append(out, *w)
		st.Total++
		if w.A != nil {
			st.Analyzed++
		}
	}
	for _, a := range s.cands {
		add(a)
	}
	for _, a := range pins {
		add(a)
	}
	return out, st
}

// Wallet returns one wallet, analysing it now if needed.
func (s *Service) Wallet(ctx context.Context, addr string) (*Wallet, error) {
	s.Touch()
	addr = strings.ToLower(addr)
	s.mu.RLock()
	var w *Wallet
	if p := s.wallets[addr]; p != nil {
		c := *p
		w = &c
	}
	s.mu.RUnlock()
	if w != nil && w.A != nil {
		c := *w
		return &c, nil
	}
	if err := s.analyse(ctx, addr, s.ui); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	c := *s.wallets[addr]
	return &c, nil
}

type Position struct {
	Coin     string  `json:"coin"`
	Size     float64 `json:"size"`
	EntryPx  float64 `json:"entry_px"`
	Value    float64 `json:"value"`
	Upnl     float64 `json:"upnl"`
	Leverage float64 `json:"leverage"`
}

func (s *Service) Positions(ctx context.Context, addr string) ([]Position, error) {
	st, err := s.hl.PublicInfo(ctx, map[string]any{"type": "clearinghouseState", "user": addr}, 2, s.ui)
	if err != nil {
		return nil, err
	}
	out := []Position{}
	for _, ap := range st.Get("assetPositions").Arr() {
		p := ap.Get("position")
		sz := f64(p.Get("szi"))
		if sz == 0 {
			continue
		}
		out = append(out, Position{Coin: p.JStr("coin"), Size: sz, EntryPx: f64(p.Get("entryPx")), Value: f64(p.Get("positionValue")), Upnl: f64(p.Get("unrealizedPnl")), Leverage: f64(p.Get("leverage").Get("value"))})
	}
	sort.Slice(out, func(i, j int) bool { return math.Abs(out[i].Value) > math.Abs(out[j].Value) })
	return out, nil
}

func f64(j util.J) float64 { v, _ := j.Dec().Float64(); return v }

// ---------- crawler ----------

func (s *Service) loop() {
	defer func() {
		if s.root.Err() == nil {
			s.save(true)
		}
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
	}()
	for {
		s.mu.RLock()
		idle := time.Since(s.lastUse)
		// After a failure, retry in a minute rather than on every pass.
		lbDue := time.Since(time.UnixMilli(s.lbAt)) > lbTTL && time.Since(s.lbTry) > time.Minute
		s.mu.RUnlock()
		if idle > idleStop || s.root.Err() != nil {
			return
		}
		if lbDue {
			s.mu.Lock()
			s.lbTry = time.Now()
			s.mu.Unlock()
			if err := s.refreshLeaderboard(s.root); err != nil {
				slog.Warn("plaza leaderboard", "err", err)
				s.mu.Lock()
				s.lbErr = err.Error()
				s.mu.Unlock()
			} else {
				s.save(true)
			}
		}
		next := s.next()
		if next == "" {
			select {
			case <-s.root.Done():
				return
			case <-time.After(15 * time.Second):
			}
			continue
		}
		if err := s.analyse(s.root, next, s.budget); err != nil {
			slog.Debug("plaza analyse", "addr", next, "err", err)
		}
		s.save(false)
	}
}

// next picks the stalest wallet that needs (re)analysis.
func (s *Service) next() string {
	pins := s.pinned(s.root)
	s.mu.RLock()
	defer s.mu.RUnlock()
	cutoff := util.NowMs() - analysisTTL.Milliseconds()
	for _, list := range [][]string{pins, s.cands} {
		for _, a := range list {
			w := s.wallets[a]
			if w == nil || ((w.A == nil || w.A.At < cutoff) && w.Err == "") {
				return a
			}
		}
	}
	// Retry failures last.
	for _, a := range s.cands {
		if w := s.wallets[a]; w != nil && w.Err != "" && w.A == nil {
			return a
		}
	}
	return ""
}

type lbRow struct {
	EthAddress  string               `json:"ethAddress"`
	AccountVal  string               `json:"accountValue"`
	DisplayName *string              `json:"displayName"`
	Windows     [][2]json.RawMessage `json:"windowPerformances"`
}

func parseF(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }

func (s *Service) refreshLeaderboard(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, leaderboardURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "merchandiser/0.1")
	resp, err := s.lbHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("获取 Hyperliquid 排行榜失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("获取 Hyperliquid 排行榜失败: HTTP %d", resp.StatusCode)
	}
	var body struct {
		Rows []lbRow `json:"leaderboardRows"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return fmt.Errorf("解析 Hyperliquid 排行榜失败: %w", err)
	}
	var pool []*Wallet
	for _, r := range body.Rows {
		eq := parseF(r.AccountVal)
		if eq < minEquity {
			continue
		}
		w := &Wallet{Address: strings.ToLower(r.EthAddress), DisplayName: r.DisplayName, LbEquity: eq, Perf: map[string]Perf{}}
		for _, pair := range r.Windows {
			var name string
			var p struct{ Pnl, Roi, Vlm string }
			if json.Unmarshal(pair[0], &name) != nil || json.Unmarshal(pair[1], &p) != nil {
				continue
			}
			for k, v := range hlWindow {
				if v == name {
					w.Perf[k] = Perf{Pnl: parseF(p.Pnl), Roi: parseF(p.Roi), Vlm: parseF(p.Vlm)}
				}
			}
		}
		pool = append(pool, w)
	}
	// Candidates: top by PnL per window among profitable wallets.
	picked := map[string]bool{}
	var cands []string
	take := func(win string, n int) {
		sorted := make([]*Wallet, 0, len(pool))
		for _, w := range pool {
			// Volume ÷ equity over 30 days > 500×: market maker, not copyable.
			if w.Perf["30d"].Vlm > 500*w.LbEquity {
				continue
			}
			if p := w.Perf[win]; p.Pnl > 0 && p.Roi > 0 {
				sorted = append(sorted, w)
			}
		}
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].Perf[win].Pnl > sorted[j].Perf[win].Pnl })
		for _, w := range sorted {
			if n == 0 {
				break
			}
			if !picked[w.Address] {
				picked[w.Address] = true
				cands = append(cands, w.Address)
				n--
			}
		}
	}
	take("30d", 30)
	take("7d", 15)
	take("all", 15)

	pins := map[string]bool{}
	for _, a := range s.pinned(ctx) {
		pins[a] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, w := range pool {
		if !picked[w.Address] && !pins[w.Address] && s.wallets[w.Address] == nil {
			continue
		}
		if old := s.wallets[w.Address]; old != nil {
			w.A, w.Err = old.A, old.Err
		}
		s.wallets[w.Address] = w
	}
	s.cands = cands
	s.lbAt = util.NowMs()
	s.lbErr = ""
	s.dirty = true
	return nil
}

func (s *Service) analyse(ctx context.Context, addr string, budget *exchange.TokenBucket) error {
	a, perf, err := s.fetch(ctx, addr, budget)
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.wallets[addr]
	if w == nil {
		w = &Wallet{Address: addr, Perf: map[string]Perf{}}
		s.wallets[addr] = w
	}
	if err != nil {
		w.Err = err.Error()
		return err
	}
	w.Err = ""
	w.A = a
	s.dirty = true
	// Not on the leaderboard: derive window performance from the portfolio.
	for k, p := range perf {
		if _, ok := w.Perf[k]; !ok {
			w.Perf[k] = p
		}
	}
	return nil
}

func (s *Service) fetch(ctx context.Context, addr string, budget *exchange.TokenBucket) (*Analysis, map[string]Perf, error) {
	pf, err := s.hl.PublicInfo(ctx, map[string]any{"type": "portfolio", "user": addr}, 20, budget)
	if err != nil {
		return nil, nil, err
	}
	a := &Analysis{At: util.NowMs(), MaxDD: map[string]float64{}, Curve: map[string][][2]float64{}, UpShare: map[string]float64{}}
	perf := map[string]Perf{}
	for _, pair := range pf.Arr() {
		name := pair.At(0).Str()
		var win string
		for k, v := range hlWindow {
			if v == name {
				win = k
			}
		}
		if win == "" {
			continue
		}
		data := pair.At(1)
		av := series(data.Get("accountValueHistory"))
		pnl := series(data.Get("pnlHistory"))
		a.MaxDD[win], a.UpShare[win] = drawdown(av, pnl)
		a.Curve[win] = downsample(pnl, 60)
		if win == "all" && len(av) > 0 {
			a.Equity = av[len(av)-1][1]
		}
		if len(pnl) > 0 {
			p := Perf{Pnl: pnl[len(pnl)-1][1], Vlm: f64(data.Get("vlm"))}
			if len(av) > 0 && av[0][1] > 0 {
				p.Roi = p.Pnl / av[0][1]
			}
			perf[win] = p
		}
	}
	since := util.NowMs() - 7*24*3600*1000
	fills, err := s.hl.PublicInfo(ctx, map[string]any{"type": "userFillsByTime", "user": addr, "startTime": since, "aggregateByTime": true}, 20, budget)
	if err != nil {
		return nil, nil, err
	}
	arr := fills.Arr()
	// Fills cost one extra weight per 20 items.
	if extra := float64(len(arr) / 20); extra > 0 {
		_ = budget.Acquire(ctx, extra, false)
	}
	fillStats(a, arr, since)
	return a, perf, nil
}

func series(j util.J) [][2]float64 {
	var out [][2]float64
	for _, p := range j.Arr() {
		ts, _ := p.At(0).Int()
		out = append(out, [2]float64{float64(ts), f64(p.At(1))})
	}
	return out
}

// drawdown: largest fall of cumulative PnL from its peak, relative to the
// account value at that peak (deposits and withdrawals do not count).
// Also returns the share of rising steps.
func drawdown(av, pnl [][2]float64) (float64, float64) {
	if len(pnl) < 2 {
		return 0, 0
	}
	avAt := func(i int) float64 {
		if i < len(av) {
			return av[i][1]
		}
		if len(av) > 0 {
			return av[len(av)-1][1]
		}
		return 0
	}
	peak, peakAv, dd := pnl[0][1], avAt(0), 0.0
	up, steps := 0, 0
	for i := 1; i < len(pnl); i++ {
		v := pnl[i][1]
		if d := v - pnl[i-1][1]; d != 0 {
			steps++
			if d > 0 {
				up++
			}
		}
		if v > peak {
			peak, peakAv = v, avAt(i)
			continue
		}
		// Peak equity ≈ trough equity + the drop; guards against a tiny
		// account value at the peak (curve starting at a fresh account).
		if den := math.Max(peakAv, avAt(i)+(peak-v)); den > 0 {
			dd = math.Max(dd, (peak-v)/den)
		}
	}
	share := 0.0
	if steps > 0 {
		share = float64(up) / float64(steps)
	}
	return math.Min(dd, 1), share
}

func downsample(p [][2]float64, n int) [][2]float64 {
	if len(p) <= n {
		return p
	}
	out := make([][2]float64, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, p[i*(len(p)-1)/(n-1)])
	}
	return out
}

// fillStats derives trade frequency, win rate and holding time from fills
// (any order). Holding time pairs a flat→open fill with the fill that brings
// the coin back to flat (or flips it).
func fillStats(a *Analysis, fills []util.J, since int64) {
	type fill struct {
		t         int64
		coin      string
		start, sz float64
		buy       bool
		closedPnl float64
	}
	fs := make([]fill, 0, len(fills))
	for _, f := range fills {
		t, _ := f.Get("time").Int()
		fs = append(fs, fill{t: t, coin: f.JStr("coin"), start: f64(f.Get("startPosition")), sz: f64(f.Get("sz")), buy: f.JStr("side") == "B", closedPnl: f64(f.Get("closedPnl"))})
	}
	sort.Slice(fs, func(i, j int) bool { return fs[i].t < fs[j].t })
	now := util.NowMs()
	coins := map[string]bool{}
	if len(fs) == 0 {
		a.Coins = []string{}
		return
	}
	from := since
	if len(fs) >= 2000 { // capped: the window is what the cap covered
		from = fs[0].t
	}
	days := math.Max(float64(now-from)/86_400_000, 1.0/24)
	a.TradesPerDay = math.Round(float64(len(fs))/days*10) / 10

	wins, closes := 0, 0
	openAt := map[string]int64{}
	var holds []float64
	const eps = 1e-12
	for _, f := range fs {
		coins[f.coin] = true
		if f.closedPnl != 0 {
			closes++
			if f.closedPnl > 0 {
				wins++
			}
		}
		d := f.sz
		if !f.buy {
			d = -d
		}
		end := f.start + d
		flat := math.Abs(f.start) < eps
		if flat && math.Abs(end) > eps {
			openAt[f.coin] = f.t
			continue
		}
		if t0, ok := openAt[f.coin]; ok && !flat {
			if math.Abs(end) < eps {
				holds = append(holds, float64(f.t-t0)/1000)
				delete(openAt, f.coin)
			} else if (end > 0) != (f.start > 0) { // flipped
				holds = append(holds, float64(f.t-t0)/1000)
				openAt[f.coin] = f.t
			}
		}
	}
	if closes > 0 {
		wr := float64(wins) / float64(closes)
		a.WinRate = &wr
	}
	if len(holds) > 0 {
		sum := 0.0
		for _, h := range holds {
			sum += h
		}
		avg := sum / float64(len(holds))
		a.AvgHoldSec = &avg
	} else {
		// No round trip closed in the window: holds at least that long.
		span := float64(now-from) / 1000
		a.AvgHoldSec = &span
	}
	for c := range coins {
		a.Coins = append(a.Coins, c)
	}
	sort.Strings(a.Coins)
}
