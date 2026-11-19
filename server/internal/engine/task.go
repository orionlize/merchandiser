package engine

// One runner per active task. Each step: read the source, detect signals,
// compute every follower's target per coin, run risk checks, place the
// difference, and keep mirrored resting orders in line with the source.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/exchange"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

type cmdKind int

const (
	cmdPause cmdKind = iota
	cmdResume
	cmdReconcile
	cmdReload
	cmdCancelMirrors
	cmdStop
)

type taskCmd struct {
	kind  cmdKind
	close *bool
	done  chan struct{}
}

type CompareRow struct {
	Base         string  `json:"base"`
	ConnectionID string  `json:"connection_id"`
	Alias        string  `json:"alias"`
	Src          string  `json:"src"`
	Target       *string `json:"target"`
	Actual       *string `json:"actual"`
	Deviation    *string `json:"deviation"`
	// synced | pending | expected | dust | skipped | error | ignored
	State string `json:"state"`
	Note  string `json:"note"`
}

type FollowerLive struct {
	ConnectionID string `json:"connection_id"`
	Alias        string `json:"alias"`
	Equity       string `json:"equity"`
	Upnl         string `json:"upnl"`
	Notional     string `json:"notional"`
}

type TaskLive struct {
	SourceConnected bool           `json:"source_connected"`
	SourceEquity    string         `json:"source_equity"`
	SourceNotional  string         `json:"source_notional"`
	TargetNotional  string         `json:"target_notional"`
	ActualNotional  string         `json:"actual_notional"`
	DeviationPct    string         `json:"deviation_pct"`
	LastReconcile   *int64         `json:"last_reconcile"`
	LastError       *string        `json:"last_error"`
	Rows            []CompareRow   `json:"rows"`
	Followers       []FollowerLive `json:"followers"`
	// Follower positions in the coins this task manages.
	Positions []PositionLive `json:"positions"`
	Paused    bool           `json:"paused"`
}

// StrSet serialises as a JSON array.
type StrSet map[string]struct{}

func (s StrSet) MarshalJSON() ([]byte, error) {
	out := make([]string, 0, len(s))
	for k := range s {
		out = append(out, k)
	}
	sort.Strings(out)
	return json.Marshal(out)
}

func (s *StrSet) UnmarshalJSON(b []byte) error {
	var a []string
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	*s = StrSet{}
	for _, x := range a {
		(*s)[x] = struct{}{}
	}
	return nil
}

func (s StrSet) Has(k string) bool { _, ok := s[k]; return ok }

// Baseline is persisted runtime state that must survive restarts.
type Baseline struct {
	// Coins ignored under the "new positions only" start policy.
	Ignored StrSet `json:"ignored"`
	// Source size at open per coin (fixed-notional sizing).
	OpenSizes   map[string]decimal.Decimal `json:"open_sizes"`
	Initialized bool                       `json:"initialized"`
}

func newBaseline() Baseline {
	return Baseline{Ignored: StrSet{}, OpenSizes: map[string]decimal.Decimal{}}
}

type followerCtx struct {
	connID      string
	alias       string
	ex          exchange.Exchange
	markets     *exchange.Markets
	sizing      Sizing
	leverage    Leverage
	startEquity *decimal.Decimal
	snap        *model.AccountSnapshot
	cooldown    map[string]time.Time
}

type taskRunner struct {
	e             *Engine
	id            string
	name          string
	rules         Rules
	risk          Risk
	source        exchange.Exchange
	sourceMarkets *exchange.Markets
	sourceKind    string
	// Source equity is unknown (see store.SourceRow.HidesEquity).
	hidesEquity         bool
	sourceAddress       string
	sourceTestnet       bool
	followers           []*followerCtx
	prev                *model.AccountSnapshot
	baseline            Baseline
	lastSourceOk        int64
	lostHandled         bool
	lastReconcile       int64
	lastFollowerRefresh int64
	loops               uint64
	alerted             map[string]int64
	paused              bool
}

const stepInterval = time.Second

func prepareRunner(ctx context.Context, e *Engine, taskID string, freshStart bool) (*taskRunner, error) {
	t, err := store.Task(ctx, e.DB, taskID)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, errs.Msg("任务不存在")
	}
	var rules Rules
	if err := json.Unmarshal([]byte(t.RulesJSON), &rules); err != nil {
		return nil, err
	}
	var risk Risk
	if err := json.Unmarshal([]byte(t.RiskJSON), &risk); err != nil {
		return nil, err
	}
	src, err := store.Source(ctx, e.DB, t.SourceID)
	if err != nil {
		return nil, err
	}
	if src == nil {
		return nil, errs.Msg("信号源不存在")
	}
	source, err := e.SourceAdapter(ctx, src)
	if err != nil {
		return nil, err
	}
	sourceMarkets, err := e.Markets(ctx, source)
	if err != nil {
		return nil, err
	}
	frows, err := store.Followers(ctx, e.DB, taskID)
	if err != nil {
		return nil, err
	}
	var followers []*followerCtx
	for _, f := range frows {
		ex, err := e.Adapter(ctx, f.ConnectionID)
		if err != nil {
			return nil, err
		}
		m, err := e.Markets(ctx, ex)
		if err != nil {
			return nil, err
		}
		var ov FollowerOverride
		if f.OverrideJSON != nil {
			if err := json.Unmarshal([]byte(*f.OverrideJSON), &ov); err != nil {
				return nil, err
			}
		}
		alias := ""
		if c, _ := store.Connection(ctx, e.DB, f.ConnectionID); c != nil {
			alias = c.Alias
		}
		fc := &followerCtx{connID: f.ConnectionID, alias: alias, ex: ex, markets: m, sizing: rules.Sizing, leverage: rules.Leverage, cooldown: map[string]time.Time{}}
		if ov.Sizing != nil {
			fc.sizing = *ov.Sizing
		}
		if ov.Leverage != nil {
			fc.leverage = *ov.Leverage
		}
		if f.StartEquity != nil {
			se := util.Dec(*f.StartEquity)
			fc.startEquity = &se
		}
		followers = append(followers, fc)
	}
	if len(followers) == 0 {
		return nil, errs.Msg("任务没有跟单账户")
	}
	baseline := newBaseline()
	if t.BaselineJSON != nil && !freshStart {
		if err := json.Unmarshal([]byte(*t.BaselineJSON), &baseline); err != nil {
			return nil, err
		}
		if baseline.Ignored == nil {
			baseline.Ignored = StrSet{}
		}
		if baseline.OpenSizes == nil {
			baseline.OpenSizes = map[string]decimal.Decimal{}
		}
	}
	// Refuse to run with a badly skewed clock.
	for _, f := range followers {
		if st, err := f.ex.ServerTime(ctx); err == nil && st != nil {
			skew := util.NowMs() - *st
			if skew < 0 {
				skew = -skew
			}
			if skew > 2_000 {
				return nil, errs.Msg("%s 服务器时钟偏差 %d ms，过大，请校准系统时间（NTP）", f.alias, skew)
			}
		}
	}
	addr := ""
	if src.Address != nil {
		addr = *src.Address
	}
	return &taskRunner{
		e: e, id: t.ID, name: t.Name, rules: rules, risk: risk, source: source, sourceMarkets: sourceMarkets,
		sourceKind: src.Kind, hidesEquity: src.HidesEquity(), sourceAddress: addr, sourceTestnet: src.Testnet, followers: followers,
		baseline: baseline, lastSourceOk: util.NowMs(), alerted: map[string]int64{},
	}, nil
}

func (r *taskRunner) saveBaseline(ctx context.Context) {
	if j, err := json.Marshal(r.baseline); err == nil {
		_, _ = r.e.DB.ExecContext(ctx, "UPDATE tasks SET baseline_json = ? WHERE id = ?", string(j), r.id)
	}
}

func (r *taskRunner) recordStartEquity(ctx context.Context) {
	for _, f := range r.followers {
		if f.startEquity != nil {
			continue
		}
		if s, err := f.ex.Snapshot(ctx, f.markets, false); err == nil {
			eq := s.Equity
			f.startEquity = &eq
			_, _ = r.e.DB.ExecContext(ctx, "UPDATE task_followers SET start_equity = ? WHERE task_id = ? AND connection_id = ?", eq.String(), r.id, f.connID)
		}
	}
}

func (r *taskRunner) run(ctx context.Context, cmds <-chan taskCmd) {
	notify := make(chan struct{}, 1)
	var wsOk atomic.Bool
	wsOk.Store(true)
	wsCtx, stopWs := context.WithCancel(ctx)
	defer stopWs()
	if r.sourceKind == "hl_address" || r.source.Platform() == model.Hyperliquid {
		if r.sourceAddress != "" {
			go exchange.WatchUser(wsCtx, r.sourceAddress, r.sourceTestnet, notify, &wsOk)
		}
	}
	r.recordStartEquity(ctx)
	force := true
	tick := time.NewTicker(stepInterval)
	defer tick.Stop()
	doStep := true
	for {
		if doStep && !r.paused {
			sctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			if err := r.step(sctx, force, wsOk.Load()); err != nil {
				slog.Warn("step error", "task", r.name, "err", err)
				msg := err.Error()
				r.e.updateLive(r.id, func(l *TaskLive) { l.LastError = &msg })
			}
			cancel()
			force = false
			r.loops++
		}
		doStep = true
		select {
		case <-ctx.Done():
			return
		case c := <-cmds:
			switch c.kind {
			case cmdPause:
				r.paused = true
				r.publishPaused()
				doStep = false
			case cmdResume:
				r.paused = false
				force = true
			case cmdReconcile:
				force = true
			case cmdReload:
				if fresh, err := prepareRunner(ctx, r.e, r.id, false); err == nil {
					r.rules, r.risk, r.followers = fresh.rules, fresh.risk, fresh.followers
					r.recordStartEquity(ctx)
					force = true
				} else {
					slog.Warn("reload failed", "task", r.name, "err", err)
				}
			case cmdCancelMirrors:
				r.cancelAllMirrors(ctx, "全局急停")
				doStep = false
			case cmdStop:
				stopWs()
				sctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
				r.cancelAllMirrors(sctx, "任务停止")
				closeAll := r.rules.Stop == "close_all"
				if c.close != nil {
					closeAll = *c.close
				}
				if closeAll {
					r.closeAllPositions(sctx, "停止任务时平仓")
				}
				cancel()
				if c.done != nil {
					close(c.done)
				}
				return
			}
		case <-notify:
		case <-tick.C:
		}
	}
}

func (r *taskRunner) publishPaused() {
	r.e.updateLive(r.id, func(l *TaskLive) { l.Paused = true })
	r.e.Changed("tasks")
}

func (r *taskRunner) supportsOrders() bool { return r.sourceKind != "lead_trader" }

func (r *taskRunner) step(ctx context.Context, force, wsOk bool) error {
	now := util.NowMs()
	// Binance openOrders is heavy (weight 40): poll it every 5th loop.
	ordersEvery := uint64(1)
	if r.source.Platform() == model.Binance {
		ordersEvery = 5
	}
	wantOrders := r.rules.Mirror.Enabled && r.supportsOrders() && (r.loops%ordersEvery == 0 || force)
	src, err := r.source.Snapshot(ctx, r.sourceMarkets, wantOrders)
	if err != nil {
		r.onSourceLost(ctx, now, err.Error())
		return err
	}
	if r.lostHandled {
		r.e.Alert("ok", &r.id, nil, r.name+" 信号源已恢复", util.Ptr("已全量对账"))
	}
	r.lastSourceOk = now
	r.lostHandled = false
	if !wsOk && now-r.lastSourceOk > int64(r.risk.SourceLostSecs)*1000 {
		r.onSourceLost(ctx, now, "WebSocket 断线")
	}
	// Keep previous orders when we skipped fetching them this loop.
	if !wantOrders && r.prev != nil {
		src.Orders = r.prev.Orders
	}

	if !r.baseline.Initialized {
		if r.rules.Start == "new_only" {
			r.baseline.Ignored = StrSet{}
			for _, p := range src.Positions {
				if !p.Size.IsZero() {
					r.baseline.Ignored[p.Base] = struct{}{}
				}
			}
		}
		for _, p := range src.Positions {
			r.baseline.OpenSizes[p.Base] = p.Size
		}
		r.baseline.Initialized = true
		r.saveBaseline(ctx)
	}

	signals := r.detectSignals(ctx, src)
	changed := len(signals) > 0
	mirrorsActive := r.hasActiveMirrors(ctx)
	reconcileMs := int64(r.rules.ReconcileSecs) * 1000
	reconcileDue := now-r.lastReconcile >= reconcileMs
	refreshEvery := reconcileMs
	if mirrorsActive {
		refreshEvery = 3000
	}
	followerRefreshDue := now-r.lastFollowerRefresh >= refreshEvery

	if !(changed || force || reconcileDue || followerRefreshDue || mirrorsActive) {
		r.prev = src
		return nil
	}

	// Refresh follower snapshots concurrently.
	withOrders := r.rules.Mirror.Enabled
	snaps := make([]*model.AccountSnapshot, len(r.followers))
	var wg sync.WaitGroup
	for i, f := range r.followers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, err := f.ex.Snapshot(ctx, f.markets, withOrders)
			if err != nil {
				slog.Warn("follower snapshot", "alias", f.alias, "err", err)
				return
			}
			snaps[i] = s
		}()
	}
	wg.Wait()
	for i, s := range snaps {
		if s != nil {
			r.followers[i].snap = s
			r.e.RememberSnapshot(r.followers[i].connID, s)
		}
	}
	r.lastFollowerRefresh = now

	if r.rules.Mirror.Enabled && r.supportsOrders() {
		r.syncMirrors(ctx, src)
	}

	reconcile := force || reconcileDue
	if changed || reconcile {
		r.syncPositions(ctx, src, signals, reconcile)
		if reconcile {
			r.lastReconcile = now
		}
	}
	r.checkLossLimits(ctx)
	r.publish(src)
	r.prev = src
	return nil
}

func (r *taskRunner) onSourceLost(ctx context.Context, now int64, why string) {
	lostFor := now - r.lastSourceOk
	if lostFor < int64(r.risk.SourceLostSecs)*1000 || r.lostHandled {
		return
	}
	r.lostHandled = true
	r.e.updateLive(r.id, func(l *TaskLive) { l.SourceConnected = false })
	action := "保持仓位，暂不新开仓"
	switch r.risk.SourceLostAction {
	case "pause":
		action = "任务已暂停"
	case "close":
		action = "已市价平仓并暂停"
	}
	r.e.Alert("warn", &r.id, nil, fmt.Sprintf("%s 信号源失联 %d 秒", r.name, lostFor/1000), util.Ptr(why+"；"+action))
	switch r.risk.SourceLostAction {
	case "pause":
		r.paused = true
		_ = store.SetTaskStatus(ctx, r.e.DB, r.id, "paused", util.Ptr("信号源失联"))
		r.e.Changed("tasks")
	case "close":
		r.closeAllPositions(ctx, "信号源失联平仓")
		r.paused = true
		_ = store.SetTaskStatus(ctx, r.e.DB, r.id, "paused", util.Ptr("信号源失联，已平仓"))
		r.e.Changed("tasks")
	}
}

// detectSignals compares the source's net positions with the previous read;
// logs and returns coin → signal id.
func (r *taskRunner) detectSignals(ctx context.Context, src *model.AccountSnapshot) map[string]int64 {
	out := map[string]int64{}
	prev := r.prev
	if prev == nil {
		return out
	}
	bases := map[string]struct{}{}
	for _, p := range src.Positions {
		bases[p.Base] = struct{}{}
	}
	for _, p := range prev.Positions {
		bases[p.Base] = struct{}{}
	}
	for base := range bases {
		a, b := prev.Position(base), src.Position(base)
		if a.Equal(b) {
			continue
		}
		var kind, label string
		switch {
		case a.IsZero():
			kind, label = "open", "开空"
			if b.IsPositive() {
				label = "开多"
			}
		case b.IsZero():
			kind, label = "close", "平仓"
		case a.Sign() != b.Sign():
			kind, label = "flip", "反手"
		case b.Abs().GreaterThan(a.Abs()):
			kind, label = "add", "加仓"
		default:
			kind, label = "reduce", "减仓"
		}
		// Baseline bookkeeping.
		if kind == "open" || kind == "flip" {
			r.baseline.OpenSizes[base] = b
		}
		if kind == "close" || kind == "flip" {
			// A pre-existing position closed or flipped: follow from here on.
			delete(r.baseline.Ignored, base)
		}
		if kind == "close" {
			delete(r.baseline.OpenSizes, base)
		}
		delta := b.Sub(a)
		plus := ""
		if delta.IsPositive() {
			plus = "+"
		}
		text := fmt.Sprintf("%s %s %s%s（%s → %s）", base, label, plus, util.Fmt(delta), util.Fmt(a), util.Fmt(b))
		id, err := store.InsertSignal(ctx, r.e.DB, r.id, base, kind, &a, &b, text, signalSource(prev, src, base))
		if err != nil {
			slog.Error("signal insert", "err", err)
			continue
		}
		out[base] = id
	}
	if len(out) > 0 {
		r.saveBaseline(ctx)
		r.e.Changed("signals")
	}
	return out
}

// posOf returns the net size and size-weighted entry / mark of a coin.
func posOf(s *model.AccountSnapshot, base string) (size, entry, mark decimal.Decimal) {
	var gross, en, mk decimal.Decimal
	for _, p := range s.Positions {
		if p.Base != base || p.Size.IsZero() {
			continue
		}
		size = size.Add(p.Size)
		gross = gross.Add(p.Size.Abs())
		en = en.Add(p.Size.Abs().Mul(p.EntryPx))
		mk = mk.Add(p.Size.Abs().Mul(p.MarkPx))
	}
	if gross.IsPositive() {
		entry, mark = en.Div(gross), mk.Div(gross)
	}
	return
}

// signalSource records what the source itself did between two snapshots:
// from its own fills when the source exposes them (exact price, venue time
// and realised PnL), otherwise inferred from positions — the price of an
// open / add follows from the entry change, a reduce takes the mark at
// detection, and the time is the detection time.
func signalSource(prev, cur *model.AccountSnapshot, base string) *store.SignalSrc {
	a, ea, ma := posOf(prev, base)
	b, eb, mb := posOf(cur, base)
	out := &store.SignalSrc{}
	dec := func(d decimal.Decimal) *string {
		if !d.IsPositive() && !d.IsNegative() {
			return nil
		}
		v := util.Fmt(d)
		return &v
	}
	out.SrcEntry = dec(ea)
	out.SrcEquity = dec(cur.Equity)
	if pc, ok := prev.Trades[base]; ok {
		if cc, ok := cur.Trades[base]; ok {
			dq, dn := cc.Qty.Sub(pc.Qty), cc.Notional.Sub(pc.Notional)
			// Totals go backwards when the source is rebuilt from history.
			if dq.IsPositive() && dn.IsPositive() {
				ts := cc.LastTs
				out.SrcTs = &ts
				out.SrcPx = dec(dn.Div(dq))
				r := util.Fmt(cc.Realized.Sub(pc.Realized))
				out.SrcRealized = &r
				out.SrcBasis = util.Ptr("fills")
				return out
			}
		}
	}
	out.SrcBasis = util.Ptr("positions")
	switch {
	case a.IsZero() || a.Sign() != b.Sign() && !b.IsZero():
		// Open or flip: the new leg's entry is its fill price.
		out.SrcPx = dec(eb)
	case b.Abs().GreaterThan(a.Abs()):
		// Add: entry_b·|b| = entry_a·|a| + px·(|b|−|a|).
		if d := b.Abs().Sub(a.Abs()); d.IsPositive() && eb.IsPositive() && ea.IsPositive() {
			px := eb.Mul(b.Abs()).Sub(ea.Mul(a.Abs())).Div(d)
			if px.IsPositive() {
				out.SrcPx = dec(px)
			}
		}
	default:
		// Reduce / close: only the mark is known.
		if mb.IsPositive() {
			out.SrcPx = dec(mb)
		} else {
			out.SrcPx = dec(ma)
		}
	}
	return out
}

func (r *taskRunner) hasActiveMirrors(ctx context.Context) bool {
	n, err := store.Count(ctx, r.e.DB, "SELECT COUNT(*) FROM mirrors WHERE task_id = ? AND status IN ('live','filled','grace')", r.id)
	return err == nil && n > 0
}

// mirrorState returns the signed quantity already filled by mirrors whose
// source order is still open (expected deviation), and the coins in grace.
func (r *taskRunner) mirrorState(ctx context.Context, connID string) (map[string]decimal.Decimal, map[string]bool) {
	rows, _ := store.Mirrors(ctx, r.e.DB, "WHERE task_id = ? AND connection_id = ? AND status IN ('live','filled','grace')", r.id, connID)
	exp := map[string]decimal.Decimal{}
	grace := map[string]bool{}
	for _, m := range rows {
		if m.Status == "grace" {
			grace[m.Base] = true
			continue
		}
		f := util.Dec(m.Filled)
		if !f.IsZero() && m.Kind == "limit" {
			if !m.Buy {
				f = f.Neg()
			}
			exp[m.Base] = exp[m.Base].Add(f)
		}
	}
	return exp, grace
}

type planKind int

const (
	planNothing planKind = iota
	planOrders
	planSkip
	planAlertOnly
)

type plan struct {
	kind   planKind
	orders []*planned
	text   string
}

type planned struct {
	base     string
	spec     model.ContractSpec
	req      model.OrderRequest
	purpose  string
	leverage *uint32
	signalID *int64
}

func newPlanned(base string, spec *model.ContractSpec, buy bool, qty decimal.Decimal, reduceOnly bool, refPx decimal.Decimal, purpose string, lev *uint32) *planned {
	return &planned{
		base: base, spec: *spec, purpose: purpose, leverage: lev,
		req: model.OrderRequest{Buy: buy, Qty: qty, Type: model.OrderType{Kind: model.OrderMarket}, ReduceOnly: reduceOnly, ClientID: util.NewClientID(), RefPx: refPx},
	}
}

func (r *taskRunner) syncPositions(ctx context.Context, src *model.AccountSnapshot, signals map[string]int64, reconcile bool) {
	bases := map[string]struct{}{}
	for _, p := range src.Positions {
		bases[p.Base] = struct{}{}
	}
	for _, f := range r.followers {
		if f.snap != nil {
			for _, p := range f.snap.Positions {
				bases[p.Base] = struct{}{}
			}
		}
	}
	// Only coins the source has touched since start are ours to manage.
	for b := range bases {
		_, open := r.baseline.OpenSizes[b]
		_, sig := signals[b]
		if !open && src.Position(b).IsZero() && !sig {
			delete(bases, b)
		}
	}
	sortedBases := make([]string, 0, len(bases))
	for b := range bases {
		sortedBases = append(sortedBases, b)
	}
	sort.Strings(sortedBases)

	type fplan struct {
		fi     int
		orders []*planned
	}
	var plans []fplan
	for fi, f := range r.followers {
		fs := f.snap
		if fs == nil {
			continue
		}
		expected, grace := r.mirrorState(ctx, f.connID)
		var orders []*planned
		for _, base := range sortedBases {
			sigID, hasSig := signals[base]
			if !hasSig && !reconcile {
				continue
			}
			if t, ok := f.cooldown[base]; ok && time.Since(t) < 10*time.Second && !hasSig {
				continue
			}
			if grace[base] {
				continue
			}
			var sigPtr *int64
			if hasSig {
				id := sigID
				sigPtr = &id
			}
			p := r.planOne(f, fs, src, base, expected[base], reconcile && !hasSig)
			switch p.kind {
			case planOrders:
				for _, o := range p.orders {
					o.signalID = sigPtr
					orders = append(orders, o)
				}
			case planSkip:
				if hasSig {
					r.logSkip(ctx, f, base, sigPtr, p.text)
				}
			case planAlertOnly:
				key := f.connID + ":" + base
				if util.NowMs()-r.alerted[key] > 3_600_000 {
					r.alerted[key] = util.NowMs()
					r.e.Alert("warn", &r.id, &f.connID, fmt.Sprintf("%s %s 偏差超出容差", f.alias, base), &p.text)
				}
			}
		}
		// Reduce-only first: closing beats opening.
		sort.SliceStable(orders, func(i, j int) bool { return orders[i].req.ReduceOnly && !orders[j].req.ReduceOnly })
		if len(orders) > 0 {
			plans = append(plans, fplan{fi, orders})
		}
	}
	if len(plans) == 0 {
		return
	}
	failed := make([][]string, len(plans))
	var wg sync.WaitGroup
	for pi, p := range plans {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f := r.followers[p.fi]
			for _, o := range p.orders {
				if !r.execute(ctx, f, o) {
					failed[pi] = append(failed[pi], o.base)
				}
			}
		}()
	}
	wg.Wait()
	for pi, p := range plans {
		for _, b := range failed[pi] {
			r.followers[p.fi].cooldown[b] = time.Now()
		}
	}
	// Re-read followers after trading so the comparison view is current.
	snaps := make([]*model.AccountSnapshot, len(r.followers))
	for i, f := range r.followers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s, err := f.ex.Snapshot(ctx, f.markets, false); err == nil {
				snaps[i] = s
			}
		}()
	}
	wg.Wait()
	for i, s := range snaps {
		if s == nil {
			continue
		}
		f := r.followers[i]
		if f.snap != nil {
			s.Orders = f.snap.Orders
		}
		f.snap = s
		r.e.RememberSnapshot(f.connID, s)
	}
	r.e.Changed("orders")
}

func (r *taskRunner) srcRefPx(src *model.AccountSnapshot, base string) decimal.Decimal {
	for _, p := range src.Positions {
		if p.Base == base && !p.MarkPx.IsZero() {
			return p.MarkPx
		}
	}
	if r.prev != nil {
		for _, p := range r.prev.Positions {
			if p.Base == base {
				return p.MarkPx
			}
		}
	}
	return decimal.Zero
}

// targetFor returns the target coins for one follower and coin.
func (r *taskRunner) targetFor(f *followerCtx, fs, src *model.AccountSnapshot, base string, px decimal.Decimal) decimal.Decimal {
	raw := r.rules.Directional(src.Position(base))
	open, ok := r.baseline.OpenSizes[base]
	if !ok {
		open = raw
	}
	t := Target(&f.sizing, SizingInput{SrcSize: raw, SrcEquity: src.Equity, FollowerEquity: fs.Equity, Price: px, SrcOpenSize: r.rules.Directional(open)})
	// Risk caps (notional).
	if !px.IsZero() {
		if c := r.risk.MaxSymbolNotional; c != nil {
			mx := c.Div(px)
			if t.Abs().GreaterThan(mx) {
				t = mx.Mul(util.Signum(t))
			}
		}
		if c := r.risk.MaxTotalNotional; c != nil {
			others := decimal.Zero
			for _, p := range fs.Positions {
				if p.Base != base {
					others = others.Add(p.Size.Mul(p.MarkPx).Abs())
				}
			}
			room := util.MaxD(c.Sub(others).Div(px), decimal.Zero)
			cur := fs.Position(base)
			// Never force a reduction purely because of the total cap; just block growth.
			allowed := util.MaxD(room, util.MinD(cur.Abs(), t.Abs()))
			if t.Abs().GreaterThan(allowed) {
				t = allowed.Mul(util.Signum(t))
			}
		}
	}
	return t
}

func (r *taskRunner) planOne(f *followerCtx, fs, src *model.AccountSnapshot, base string, expectedDev decimal.Decimal, reconcileOnly bool) plan {
	if !r.rules.Allows(base) {
		return plan{kind: planSkip, text: "品种不在名单内"}
	}
	// Unknown source equity would read as a zero target and close everything.
	if f.sizing.Mode == EquityRatio && !src.Equity.IsPositive() {
		return plan{kind: planSkip, text: "信号源权益未知，无法按权益比例计算"}
	}
	if r.baseline.Ignored.Has(base) {
		return plan{kind: planSkip, text: "启动前已有持仓，按「只跟新开仓位」不跟"}
	}
	spec := f.markets.Base(base)
	if spec == nil {
		return plan{kind: planSkip, text: f.ex.Platform().Label() + " 无对应合约，已跳过"}
	}
	px := r.srcRefPx(src, base)
	if px.IsZero() {
		for _, p := range fs.Positions {
			if p.Base == base {
				px = p.MarkPx
				break
			}
		}
	}
	if px.IsZero() {
		return plan{kind: planSkip, text: "无参考价格"}
	}
	tgt := r.targetFor(f, fs, src, base, px)
	actual := fs.Position(base)
	cur := actual.Sub(expectedDev)
	delta := tgt.Sub(cur)
	if delta.IsZero() {
		return plan{kind: planNothing}
	}
	closingFully := tgt.IsZero() && !actual.IsZero()
	// Minimum change threshold and venue minimum.
	if !closingFully {
		if delta.Mul(px).Abs().LessThan(r.rules.MinChangeUSDT) {
			return plan{kind: planSkip, text: fmt.Sprintf("差额 %s 低于最小变动阈值，累计待补", util.Fmt(delta.RoundBank(6)))}
		}
		if spec.ToUnits(delta.Abs()).LessThan(spec.MinUnits()) || (!spec.MinNotional.IsZero() && delta.Mul(px).Abs().LessThan(spec.MinNotional)) {
			return plan{kind: planSkip, text: "低于最小下单量，累计待补"}
		}
	}
	if reconcileOnly {
		tol := r.rules.TolerancePct.Div(util.Hundred)
		baseSz := util.MaxD(tgt.Abs(), actual.Abs())
		if !closingFully && !baseSz.IsZero() && delta.Abs().Div(baseSz).LessThan(tol) {
			return plan{kind: planNothing}
		}
		if r.rules.ReconcileMode == "alert_only" {
			return plan{kind: planAlertOnly, text: fmt.Sprintf("目标 %s 实际 %s，偏差 %s", util.Fmt(tgt.RoundBank(6)), util.Fmt(actual), util.Fmt(delta.RoundBank(6)))}
		}
	}
	purpose := "sync"
	if reconcileOnly {
		purpose = "reconcile"
	}
	var out []*planned
	flip := !cur.IsZero() && !tgt.IsZero() && cur.Sign() != tgt.Sign()
	if flip {
		out = append(out, newPlanned(base, spec, cur.IsNegative(), cur.Abs(), true, px, purpose, nil))
		out = append(out, newPlanned(base, spec, tgt.IsPositive(), tgt.Abs(), false, px, purpose, r.desiredLeverage(f, src, base, spec)))
	} else {
		reducing := !cur.IsZero() && tgt.Abs().LessThan(cur.Abs())
		var lev *uint32
		if !reducing {
			lev = r.desiredLeverage(f, src, base, spec)
		}
		out = append(out, newPlanned(base, spec, delta.IsPositive(), delta.Abs(), reducing, px, purpose, lev))
	}
	return plan{kind: planOrders, orders: out}
}

func (r *taskRunner) desiredLeverage(f *followerCtx, src *model.AccountSnapshot, base string, spec *model.ContractSpec) *uint32 {
	want := f.leverage.Value
	if f.leverage.Mode == LevFollow {
		for _, p := range src.Positions {
			if p.Base == base && p.Leverage != nil {
				if l := p.Leverage.RoundBank(0); l.IsPositive() {
					want = uint32(l.IntPart())
				}
				break
			}
		}
	}
	v := max(min(want, f.leverage.Cap, max(spec.MaxLeverage, 1)), 1)
	return &v
}

func (r *taskRunner) logSkip(ctx context.Context, f *followerCtx, base string, sig *int64, reason string) {
	_, _ = store.InsertOrder(ctx, r.e.DB, &store.OrderRow{TaskID: r.id, SignalID: sig, ConnectionID: &f.connID, Base: base, Status: "skipped", Reason: &reason, Purpose: "sync"})
}

// Leverage already applied per (connection, coin); shared across tasks.
var (
	levMu    sync.Mutex
	levCache = map[string]uint32{}
)

// execute places one planned order with slippage check, leverage and
// retries. Returns success.
func (r *taskRunner) execute(ctx context.Context, f *followerCtx, p *planned) bool {
	db := r.e.DB
	row := store.OrderRow{
		TaskID: r.id, SignalID: p.signalID, ConnectionID: &f.connID, Base: p.base, Symbol: &p.spec.Symbol,
		Buy: util.Ptr(p.req.Buy), Qty: util.Ptr(util.Fmt(p.req.Qty.RoundBank(8))), ReduceOnly: p.req.ReduceOnly,
		ClientID: util.Ptr(p.req.ClientID), RefPx: util.Ptr(util.Fmt(p.req.RefPx)), Purpose: p.purpose,
	}
	// Slippage guard on opening / increasing orders.
	bid, ask, err := f.ex.BBO(ctx, &p.spec)
	if err != nil {
		row.Status = "failed"
		row.Reason = util.Ptr("读取盘口失败: " + err.Error())
		_, _ = store.InsertOrder(ctx, db, &row)
		return false
	}
	book := bid
	if p.req.Buy {
		book = ask
	}
	maxSlip := r.risk.MaxSlippagePct.Div(util.Hundred)
	if !p.req.ReduceOnly && !p.req.RefPx.IsZero() {
		var adverse decimal.Decimal
		if p.req.Buy {
			adverse = book.Sub(p.req.RefPx).Div(p.req.RefPx)
		} else {
			adverse = p.req.RefPx.Sub(book).Div(p.req.RefPx)
		}
		if adverse.GreaterThan(maxSlip) {
			row.Status = "skipped"
			row.Reason = util.Ptr(fmt.Sprintf("滑点超上限 %s%%：信号价 %s，盘口 %s（偏离 %s%%）", util.Fmt(r.risk.MaxSlippagePct), util.Fmt(p.req.RefPx), util.Fmt(book), util.Fmt(adverse.Mul(util.Hundred).RoundBank(2))))
			_, _ = store.InsertOrder(ctx, db, &row)
			return true
		}
	}
	if p.leverage != nil {
		key := f.connID + "|" + p.base
		levMu.Lock()
		cur, ok := levCache[key]
		levMu.Unlock()
		if !ok || cur != *p.leverage {
			if err := f.ex.SetLeverage(ctx, &p.spec, *p.leverage); err != nil {
				slog.Warn("set leverage", "alias", f.alias, "base", p.base, "err", err)
			}
			levMu.Lock()
			levCache[key] = *p.leverage
			levMu.Unlock()
		}
	}
	req := p.req
	if p.req.RefPx.IsZero() {
		req.RefPx = bid.Add(ask).Div(util.D(2))
	}
	if r.rules.Exec == "limit_ioc" {
		price := exchange.AggressivePx(book, req.Buy, maxSlip)
		req.Type = model.OrderType{Kind: model.OrderLimitIoc, Price: price}
		row.OrderType = util.Ptr("limit_ioc")
		row.Price = util.Ptr(util.Fmt(price))
	} else {
		req.Type = model.OrderType{Kind: model.OrderMarket}
		row.OrderType = util.Ptr("market")
	}
	t0 := time.Now()
	var lastErr error
	var result *model.OrderResult
	for attempt := range 3 {
		res, err := f.ex.Place(ctx, &p.spec, &req)
		if err == nil {
			result = res
			break
		}
		lastErr = err
		// Ambiguous outcome: the order may exist; ask before retrying.
		if !errs.Retryable(err) {
			break
		}
		if q, qerr := f.ex.Query(ctx, &p.spec, req.ClientID); qerr == nil && q != nil {
			result = q
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Duration(200*(1<<attempt)) * time.Millisecond):
		}
	}
	row.LatencyMs = util.Ptr(time.Since(t0).Milliseconds())
	if result != nil {
		row.Status = string(result.Status)
		if result.Status == model.Open {
			row.Status = "open"
		} else if result.Status == model.Rejected {
			row.Status = "failed"
		}
		row.FillQty = util.Ptr(util.Fmt(result.Filled))
		if result.AvgPx != nil {
			px := *result.AvgPx
			row.FillPx = util.Ptr(util.Fmt(px))
			if !req.RefPx.IsZero() {
				var slip decimal.Decimal
				if req.Buy {
					slip = px.Sub(req.RefPx).Div(req.RefPx)
				} else {
					slip = req.RefPx.Sub(px).Div(req.RefPx)
				}
				row.SlippageBps = util.Ptr(util.Fmt(slip.Mul(util.D(10000)).RoundBank(2)))
			}
		}
		if result.Status == model.Rejected {
			row.Reason = util.Ptr("未成交（IOC 无对手盘或被拒）")
		}
		if result.Status == model.Partial {
			row.Reason = util.Ptr(fmt.Sprintf("部分成交，余 %s 待补", util.Fmt(req.Qty.Sub(result.Filled).RoundBank(8))))
		}
		_, _ = store.InsertOrder(ctx, db, &row)
		return result.Status != model.Rejected
	}
	e := ""
	if lastErr != nil {
		e = lastErr.Error()
	}
	row.Status = "failed"
	row.Reason = util.Ptr(e + "，已重试 3 次，等待对账补单")
	_, _ = store.InsertOrder(ctx, db, &row)
	r.e.Alert("error", &r.id, &f.connID, f.alias+" 下单失败，等待对账补单", util.Ptr(p.base+" "+e))
	return false
}

// ---------- mirrored resting orders ----------

func (r *taskRunner) syncMirrors(ctx context.Context, src *model.AccountSnapshot) {
	db := r.e.DB
	now := util.NowMs()
	srcIDs := map[string]*model.OpenOrder{}
	var srcOrder []string
	for i := range src.Orders {
		o := &src.Orders[i]
		if o.Kind != model.KindOther {
			if _, dup := srcIDs[o.ID]; !dup {
				srcOrder = append(srcOrder, o.ID)
			}
			srcIDs[o.ID] = o
		}
	}
	for fi, f := range r.followers {
		if f.snap == nil {
			continue
		}
		fs := f.snap
		existing, _ := store.Mirrors(ctx, db, "WHERE task_id = ? AND connection_id = ? AND status IN ('live','filled','grace','not_mirrored')", r.id, f.connID)
		bySrc := map[string]store.MirrorRow{}
		for _, m := range existing {
			bySrc[m.SourceOrderID] = m
		}
		followerOpen := map[string]*model.OpenOrder{}
		for i := range fs.Orders {
			if c := fs.Orders[i].ClientID; c != nil {
				followerOpen[*c] = &fs.Orders[i]
			}
		}

		// 1. Track fills of live mirrors; handle source orders that vanished.
		for _, m := range existing {
			if m.Status == "not_mirrored" {
				if _, ok := srcIDs[m.SourceOrderID]; !ok {
					_, _ = db.ExecContext(ctx, "UPDATE mirrors SET status='done', updated_at=? WHERE id=?", now, m.ID)
				}
				continue
			}
			cid := ""
			if m.ClientID != nil {
				cid = *m.ClientID
			}
			qty := util.DecP(m.Qty)
			fo, onBook := followerOpen[cid]
			filled := qty // gone from the book: treat as filled
			if onBook {
				filled = util.MaxD(fo.OrigQty.Sub(fo.Qty), decimal.Zero)
			}
			so, srcAlive := srcIDs[m.SourceOrderID]
			if m.Status == "grace" {
				if m.GraceUntil == nil || *m.GraceUntil <= now {
					if onBook {
						if spec := f.markets.Base(m.Base); spec != nil {
							_ = f.ex.Cancel(ctx, spec, cid)
						}
					}
					suffix := ""
					if onBook {
						suffix = "；宽限期结束，已撤残余"
					}
					_, _ = db.ExecContext(ctx, "UPDATE mirrors SET status='done', filled=?, note=COALESCE(note,'') || ?, updated_at=? WHERE id=?", util.Fmt(filled), suffix, now, m.ID)
				}
				continue
			}
			if !srcAlive {
				// Source filled or cancelled: give our copy a grace period.
				_, _ = db.ExecContext(ctx, "UPDATE mirrors SET status='grace', filled=?, grace_until=?, updated_at=? WHERE id=?", util.Fmt(filled), now+int64(r.rules.Mirror.GraceMs), now, m.ID)
				continue
			}
			newStatus := "live"
			if !onBook {
				newStatus = "filled"
			}
			// Source order amended (price or size) → cancel and re-create.
			srcPx := so.Price
			if so.TriggerPx != nil {
				srcPx = *so.TriggerPx
			}
			amended := !util.DecP(m.SrcPrice).Equal(srcPx) || !util.Dec(m.SrcQty).Equal(so.OrigQty)
			if amended && newStatus == "live" {
				if spec := f.markets.Base(m.Base); spec != nil {
					_ = f.ex.Cancel(ctx, spec, cid)
				}
				_, _ = db.ExecContext(ctx, "UPDATE mirrors SET status='done', note='源订单已改单，重新镜像', updated_at=? WHERE id=?", now, m.ID)
				continue
			}
			if newStatus != m.Status || util.Fmt(filled) != m.Filled {
				_, _ = db.ExecContext(ctx, "UPDATE mirrors SET status=?, filled=?, updated_at=? WHERE id=?", newStatus, util.Fmt(filled), now, m.ID)
			}
		}

		// 2. Mirror new source orders.
		refreshed := map[string]bool{}
		if rows, err := db.QueryContext(ctx, "SELECT source_order_id FROM mirrors WHERE task_id = ? AND connection_id = ? AND status IN ('live','filled','grace','not_mirrored')", r.id, f.connID); err == nil {
			for rows.Next() {
				var s string
				if rows.Scan(&s) == nil {
					refreshed[s] = true
				}
			}
			rows.Close()
		}
		for _, sid := range srcOrder {
			o := srcIDs[sid]
			if refreshed[sid] {
				continue
			}
			if m, ok := bySrc[sid]; ok && m.Status != "done" {
				continue
			}
			if !r.rules.Allows(o.Base) || r.baseline.Ignored.Has(o.Base) {
				continue
			}
			r.mirrorOne(ctx, fi, fs, src, o)
		}
	}
	r.e.Changed("mirrors")
}

func (r *taskRunner) mirrorOne(ctx context.Context, fi int, fs, src *model.AccountSnapshot, o *model.OpenOrder) {
	f := r.followers[fi]
	db := r.e.DB
	now := util.NowMs()
	var kind string
	switch o.Kind {
	case model.KindLimit:
		kind = "limit"
	case model.KindStopMarket:
		kind = "stop"
	case model.KindTakeProfitMarket:
		kind = "take_profit"
	default:
		return
	}
	srcPx := o.Price
	if o.TriggerPx != nil {
		srcPx = *o.TriggerPx
	}
	var trig *string
	if o.TriggerPx != nil {
		trig = util.Ptr(util.Fmt(*o.TriggerPx))
	}
	insert := func(status string, cid *string, qty, price *decimal.Decimal, note *string) {
		var q, p *string
		if qty != nil {
			q = util.Ptr(util.Fmt(*qty))
		}
		if price != nil {
			p = util.Ptr(util.Fmt(*price))
		}
		_, _ = db.ExecContext(ctx, `INSERT INTO mirrors (task_id, connection_id, source_order_id, client_id, base, buy, kind, src_qty, src_price, qty, price, trigger_px, filled, status, note, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?, ?)`,
			r.id, f.connID, o.ID, cid, o.Base, o.Buy, kind, util.Fmt(o.OrigQty), util.Fmt(srcPx), q, p, trig, status, note, now, now)
	}
	spec := f.markets.Base(o.Base)
	if spec == nil {
		insert("not_mirrored", nil, nil, nil, util.Ptr(f.ex.Platform().Label()+" 无对应合约"))
		return
	}
	// Direction filter / reverse apply to mirrored orders as well.
	buy := o.Buy
	if r.rules.Reverse {
		buy = !buy
	}
	var qty decimal.Decimal
	if o.TriggerPx != nil && o.ReduceOnly {
		// TP / SL: same share of the follower's actual position.
		srcPos := src.Position(o.Base).Abs()
		mine := fs.Position(o.Base).Abs()
		if srcPos.IsZero() || mine.IsZero() {
			return // try again once the follower holds the position
		}
		qty = mine.Mul(util.MinD(o.Qty.Div(srcPos), util.One))
	} else {
		qty = o.Qty.Mul(OrderFactor(&f.sizing, src.Equity, fs.Equity, o.Qty.Mul(srcPx)))
	}
	if spec.ToUnits(qty).LessThan(spec.MinUnits()) {
		insert("not_mirrored", nil, &qty, nil, util.Ptr("低于最小下单量，成交后由仓位差额累计处理"))
		return
	}
	bid, ask, err := f.ex.BBO(ctx, spec)
	if err != nil {
		slog.Warn("mirror bbo", "err", err)
		return
	}
	mid := bid.Add(ask).Div(util.D(2))
	if !mid.IsZero() {
		dev := srcPx.Sub(mid).Div(mid).Mul(util.Hundred).Abs()
		if dev.GreaterThan(r.rules.Mirror.MaxDeviationPct) {
			insert("not_mirrored", nil, &qty, &srcPx, util.Ptr(fmt.Sprintf("偏离盘口 %s%%", util.Fmt(dev.RoundBank(1)))))
			return
		}
	}
	cid := util.NewClientID()
	ot := model.OrderType{Kind: model.OrderTrigger, TriggerPx: srcPx}
	switch o.Kind {
	case model.KindLimit:
		ot = model.OrderType{Kind: model.OrderLimit, Price: srcPx}
	case model.KindTakeProfitMarket:
		ot.TakeProfit = true
	}
	req := model.OrderRequest{Buy: buy, Qty: qty, Type: ot, ReduceOnly: o.ReduceOnly, ClientID: cid, RefPx: mid}
	res, err := f.ex.Place(ctx, spec, &req)
	if err != nil {
		insert("failed", &cid, &qty, &srcPx, util.Ptr(err.Error()))
		return
	}
	status := "live"
	if res.Status == model.Filled {
		status = "filled"
	}
	insert(status, &cid, &qty, &srcPx, nil)
	_, _ = store.InsertOrder(ctx, db, &store.OrderRow{
		TaskID: r.id, ConnectionID: &f.connID, Base: o.Base, Symbol: &spec.Symbol, Buy: &buy,
		Qty: util.Ptr(util.Fmt(qty.RoundBank(8))), OrderType: &kind, Price: util.Ptr(util.Fmt(srcPx)), ReduceOnly: o.ReduceOnly,
		ClientID: &cid, Status: "open", Reason: util.Ptr("镜像源订单 #" + o.ID), Purpose: "mirror",
	})
}

func (r *taskRunner) cancelAllMirrors(ctx context.Context, why string) {
	rows, _ := store.Mirrors(ctx, r.e.DB, "WHERE task_id = ? AND status IN ('live','grace')", r.id)
	for _, m := range rows {
		for _, f := range r.followers {
			if f.connID != m.ConnectionID {
				continue
			}
			if spec := f.markets.Base(m.Base); spec != nil && m.ClientID != nil {
				_ = f.ex.Cancel(ctx, spec, *m.ClientID)
			}
			break
		}
		_, _ = r.e.DB.ExecContext(ctx, "UPDATE mirrors SET status='done', note=?, updated_at=? WHERE id=?", why+"，已撤单", util.NowMs(), m.ID)
	}
	r.e.Changed("mirrors")
}

// managedBases: coins this task manages (followed since start, not pre-existing ones).
func (r *taskRunner) managedBases() map[string]bool {
	out := map[string]bool{}
	for b := range r.baseline.OpenSizes {
		if !r.baseline.Ignored.Has(b) {
			out[b] = true
		}
	}
	return out
}

// closeFollower flattens a follower. `only` limits it to the given coins
// (task stop); nil closes every position on the account (global close-all).
func (r *taskRunner) closeFollower(ctx context.Context, f *followerCtx, why string, only map[string]bool) {
	snap, err := f.ex.Snapshot(ctx, f.markets, false)
	if err != nil {
		r.e.Alert("error", &r.id, &f.connID, f.alias+" 平仓失败", util.Ptr(err.Error()))
		return
	}
	for _, p := range snap.Positions {
		if p.Size.IsZero() {
			continue
		}
		if only != nil && !only[p.Base] {
			continue
		}
		spec := f.markets.Base(p.Base)
		if spec == nil {
			continue
		}
		pl := newPlanned(p.Base, spec, p.Size.IsNegative(), p.Size.Abs(), true, p.MarkPx, "close", nil)
		pl.req.RefPx = decimal.Zero // no slippage guard when flattening
		r.execute(ctx, f, pl)
	}
	scope := "全部"
	if only != nil {
		scope = "本任务跟随的"
	}
	_, _ = store.InsertSignal(ctx, r.e.DB, r.id, "*", "risk", nil, nil, fmt.Sprintf("%s：%s %s仓位市价平掉", why, f.alias, scope), nil)
}

func (r *taskRunner) closeAllPositions(ctx context.Context, why string) {
	managed := r.managedBases()
	for _, f := range r.followers {
		r.closeFollower(ctx, f, why, managed)
	}
}

func (r *taskRunner) checkLossLimits(ctx context.Context) {
	dayStart := util.StartOfTodayMs()
	daily, total := decimal.Zero, decimal.Zero
	for _, f := range r.followers {
		s := f.snap
		if s == nil {
			continue
		}
		if _, first, err := store.EquityBounds(ctx, r.e.DB, f.connID, dayStart); err == nil && first != nil {
			daily = daily.Add(s.Equity.Sub(util.Dec(*first)))
		}
		if f.startEquity != nil {
			total = total.Add(s.Equity.Sub(*f.startEquity))
		}
	}
	var why string
	if l := r.risk.DailyLossLimit; l != nil && !l.IsZero() && daily.Neg().GreaterThanOrEqual(*l) {
		why = fmt.Sprintf("日亏损 %s 达到上限 %s", util.Fmt(daily.Neg().RoundBank(2)), util.Fmt(*l))
	} else if l := r.risk.TotalLossLimit; l != nil && !l.IsZero() && total.Neg().GreaterThanOrEqual(*l) {
		why = fmt.Sprintf("累计亏损 %s 达到上限 %s", util.Fmt(total.Neg().RoundBank(2)), util.Fmt(*l))
	}
	if why == "" {
		return
	}
	if r.risk.CloseOnLoss {
		r.closeAllPositions(ctx, "亏损上限触发")
	}
	r.cancelAllMirrors(ctx, "亏损上限触发")
	r.paused = true
	reason := why + "，已自动暂停"
	_ = store.SetTaskStatus(ctx, r.e.DB, r.id, "paused", &reason)
	_, _ = store.InsertSignal(ctx, r.e.DB, r.id, "*", "risk", nil, nil, "风控触发："+reason, nil)
	r.e.Alert("warn", &r.id, nil, r.name+" 亏损触及上限，任务已暂停", &why)
	r.e.Changed("tasks")
}

func (r *taskRunner) publish(src *model.AccountSnapshot) {
	rows := []CompareRow{}
	tgtNotional, actNotional, srcNotional := decimal.Zero, decimal.Zero, decimal.Zero
	var bases []string
	seen := map[string]bool{}
	for _, p := range src.Positions {
		if !seen[p.Base] {
			seen[p.Base] = true
			bases = append(bases, p.Base)
		}
	}
	for _, f := range r.followers {
		if f.snap == nil {
			continue
		}
		for _, p := range f.snap.Positions {
			if _, open := r.baseline.OpenSizes[p.Base]; open && !seen[p.Base] {
				seen[p.Base] = true
				bases = append(bases, p.Base)
			}
		}
	}
	for _, p := range src.Positions {
		srcNotional = srcNotional.Add(p.Size.Mul(p.MarkPx).Abs())
	}
	for _, base := range bases {
		s := src.Position(base)
		px := r.srcRefPx(src, base)
		for _, f := range r.followers {
			fs := f.snap
			if fs == nil {
				continue
			}
			actual := fs.Position(base)
			row := CompareRow{Base: base, ConnectionID: f.connID, Alias: f.alias, Src: util.Fmt(s)}
			spec := f.markets.Base(base)
			switch {
			case !r.rules.Allows(base):
				row.State, row.Note = "skipped", "名单外品种"
			case r.baseline.Ignored.Has(base):
				row.State, row.Note = "ignored", "启动前已有，不跟"
				row.Actual = util.Ptr(util.Fmt(actual))
			case spec != nil:
				tgt := r.targetFor(f, fs, src, base, px)
				tgtR := util.FloorStep(tgt.Abs().Div(spec.CoinPerUnit), spec.QtyStep).Mul(spec.CoinPerUnit).Mul(util.Signum(tgt))
				dev := actual.Sub(tgtR)
				tgtNotional = tgtNotional.Add(tgtR.Mul(px).Abs())
				actNotional = actNotional.Add(actual.Mul(px).Abs())
				row.Target = util.Ptr(util.Fmt(tgtR))
				row.Actual = util.Ptr(util.Fmt(actual))
				row.Deviation = util.Ptr(util.Fmt(dev))
				tol := r.rules.TolerancePct.Div(util.Hundred)
				basis := util.MaxD(tgtR.Abs(), actual.Abs())
				switch {
				case dev.IsZero() || (!basis.IsZero() && dev.Abs().Div(basis).LessThan(decimal.RequireFromString("0.0001"))):
					row.State, row.Note = "synced", "已同步"
				case dev.Mul(px).Abs().LessThan(r.rules.MinChangeUSDT) || spec.ToUnits(dev.Abs()).LessThan(spec.MinQty):
					row.State, row.Note = "dust", "低于最小下单量，累计待补"
				case !basis.IsZero() && dev.Abs().Div(basis).LessThan(tol):
					row.State, row.Note = "synced", "容差内"
				default:
					row.State, row.Note = "pending", "对账补单中"
				}
			default:
				row.State, row.Note = "skipped", f.ex.Platform().Label()+" 无对应合约，已跳过"
			}
			rows = append(rows, row)
		}
	}
	positions := []PositionLive{}
	for _, f := range r.followers {
		fs := f.snap
		if fs == nil {
			continue
		}
		for _, base := range bases {
			if !r.rules.Allows(base) || r.baseline.Ignored.Has(base) {
				continue
			}
			for i := range fs.Positions {
				p := &fs.Positions[i]
				if p.Base != base || p.Size.IsZero() {
					continue
				}
				pl := newPositionLive(f.connID, f.alias, p)
				if sp := srcPosition(src, base); sp != nil {
					pl.SrcSize = util.Ptr(util.Fmt(sp.Size))
					pl.SrcEntryPx = util.Ptr(util.Fmt(sp.EntryPx))
					if sp.Leverage != nil && sp.Leverage.IsPositive() {
						pl.SrcLeverage = util.Ptr(util.Fmt(sp.Leverage.RoundBank(2)))
					}
				}
				positions = append(positions, pl)
			}
		}
	}
	followers := []FollowerLive{}
	for _, f := range r.followers {
		if s := f.snap; s != nil {
			followers = append(followers, FollowerLive{ConnectionID: f.connID, Alias: f.alias, Equity: util.Fmt(s.Equity.RoundBank(2)), Upnl: util.Fmt(s.Upnl().RoundBank(2)), Notional: util.Fmt(s.Notional().RoundBank(2))})
		}
	}
	devPct := decimal.Zero
	if !tgtNotional.IsZero() {
		devPct = actNotional.Sub(tgtNotional).Abs().Div(tgtNotional).Mul(util.Hundred).RoundBank(1)
	}
	live := &TaskLive{
		SourceConnected: !r.lostHandled,
		SourceEquity:    util.Fmt(src.Equity.RoundBank(2)),
		SourceNotional:  util.Fmt(srcNotional.RoundBank(2)),
		TargetNotional:  util.Fmt(tgtNotional.RoundBank(2)),
		ActualNotional:  util.Fmt(actNotional.RoundBank(2)),
		DeviationPct:    util.Fmt(devPct),
		Rows:            rows,
		Followers:       followers,
		Positions:       positions,
		Paused:          r.paused,
	}
	if r.lastReconcile > 0 {
		lr := r.lastReconcile
		live.LastReconcile = &lr
	}
	r.e.liveMu.Lock()
	r.e.live[r.id] = live
	r.e.liveMu.Unlock()
	r.e.Changed("live")
}
