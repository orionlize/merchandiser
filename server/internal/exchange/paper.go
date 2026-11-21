package exchange

// Paper account: virtual fills against live Hyperliquid prices. Nothing is
// sent to any venue. State is persisted in SQLite after every change.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

var (
	takerFee = decimal.RequireFromString("0.00045")
	makerFee = decimal.RequireFromString("0.00015")
)

type PaperPos struct {
	Size     decimal.Decimal `json:"size"`
	Entry    decimal.Decimal `json:"entry"`
	Leverage uint32          `json:"leverage"`
}

type PaperOrder struct {
	ClientID   string           `json:"client_id"`
	Base       string           `json:"base"`
	Buy        bool             `json:"buy"`
	Qty        decimal.Decimal  `json:"qty"`
	OrigQty    decimal.Decimal  `json:"orig_qty"`
	Price      decimal.Decimal  `json:"price"`
	TriggerPx  *decimal.Decimal `json:"trigger_px"`
	TakeProfit bool             `json:"take_profit"`
	ReduceOnly bool             `json:"reduce_only"`
}

// PaperFill serialises as [ts, base, buy, qty, px, fee, client_id, maker,
// dir] (older states have the first six only).
type PaperFill struct {
	Ts           string
	Base         string
	Buy          bool
	Qty, Px, Fee decimal.Decimal
	ClientID     string
	Maker        bool
	Dir          string
}

func (f PaperFill) MarshalJSON() ([]byte, error) {
	return json.Marshal([]any{f.Ts, f.Base, f.Buy, f.Qty, f.Px, f.Fee, f.ClientID, f.Maker, f.Dir})
}

func (f *PaperFill) UnmarshalJSON(b []byte) error {
	var a []json.RawMessage
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	if len(a) < 6 || len(a) > 9 {
		return fmt.Errorf("paper fill: want 6 to 9 fields")
	}
	_ = json.Unmarshal(a[0], &f.Ts)
	_ = json.Unmarshal(a[1], &f.Base)
	_ = json.Unmarshal(a[2], &f.Buy)
	_ = json.Unmarshal(a[3], &f.Qty)
	_ = json.Unmarshal(a[4], &f.Px)
	_ = json.Unmarshal(a[5], &f.Fee)
	if len(a) > 6 {
		_ = json.Unmarshal(a[6], &f.ClientID)
	}
	if len(a) > 7 {
		_ = json.Unmarshal(a[7], &f.Maker)
	}
	if len(a) > 8 {
		_ = json.Unmarshal(a[8], &f.Dir)
	}
	return nil
}

// PaperFunding is one simulated hourly funding settlement.
type PaperFunding struct {
	Ts     int64           `json:"ts"`
	Base   string          `json:"base"`
	Size   decimal.Decimal `json:"size"`
	Amount decimal.Decimal `json:"amount"`
	Rate   decimal.Decimal `json:"rate"`
}

type PaperState struct {
	Cash      decimal.Decimal      `json:"cash"`
	Positions map[string]*PaperPos `json:"positions"`
	Orders    []PaperOrder         `json:"orders"`
	Fills     []PaperFill          `json:"fills"`
	Funding   []PaperFunding       `json:"funding,omitempty"`
	// Last funding hour settled (ms / 1h).
	FundingHour int64 `json:"funding_hour,omitempty"`
}

type Paper struct {
	id   string
	db   *sql.DB
	feed *Hyperliquid
	mu   sync.Mutex
	st   PaperState
}

func LoadPaper(ctx context.Context, id string, db *sql.DB, initial decimal.Decimal) (*Paper, error) {
	st := PaperState{Cash: initial}
	var j string
	err := db.QueryRowContext(ctx, "SELECT json FROM paper_state WHERE connection_id = ?", id).Scan(&j)
	if err == nil {
		if err := json.Unmarshal([]byte(j), &st); err != nil {
			return nil, err
		}
	} else if err != sql.ErrNoRows {
		return nil, err
	}
	if st.Positions == nil {
		st.Positions = map[string]*PaperPos{}
	}
	// Any valid address works for the public price feed.
	feed, err := NewHyperliquidPublic("0x0000000000000000000000000000000000000000", false, "")
	if err != nil {
		return nil, err
	}
	p := &Paper{id: id, db: db, feed: feed, st: st}
	if err := p.persist(ctx); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *Paper) persist(ctx context.Context) error {
	b, err := json.Marshal(p.st)
	if err != nil {
		return err
	}
	_, err = p.db.ExecContext(ctx, "INSERT INTO paper_state (connection_id, json) VALUES (?, ?) ON CONFLICT(connection_id) DO UPDATE SET json = excluded.json", p.id, string(b))
	return err
}

func applyFill(s *PaperState, base string, buy bool, qty, px, feeRate decimal.Decimal, clientID string) {
	signed := qty
	if !buy {
		signed = qty.Neg()
	}
	pos, ok := s.Positions[base]
	if !ok {
		pos = &PaperPos{Leverage: 10}
		s.Positions[base] = pos
	}
	old := pos.Size
	nw := old.Add(signed)
	// Realise PnL on the reduced part.
	if !old.IsZero() && old.Sign() != signed.Sign() {
		closed := util.MinD(qty, old.Abs())
		s.Cash = s.Cash.Add(px.Sub(pos.Entry).Mul(closed).Mul(util.Signum(old)))
	}
	switch {
	case nw.IsZero():
		pos.Entry = decimal.Zero
	case old.IsZero() || old.Sign() != nw.Sign():
		pos.Entry = px
	case nw.Abs().GreaterThan(old.Abs()):
		pos.Entry = pos.Entry.Mul(old.Abs()).Add(px.Mul(qty)).Div(nw.Abs())
	}
	pos.Size = nw
	fee := qty.Mul(px).Mul(feeRate)
	s.Cash = s.Cash.Sub(fee)
	s.Fills = append(s.Fills, PaperFill{Ts: fmt.Sprint(util.NowMs()), Base: base, Buy: buy, Qty: qty, Px: px, Fee: fee, ClientID: clientID, Maker: feeRate.Equal(makerFee), Dir: fillDir(old, nw)})
	if len(s.Fills) > 500 {
		s.Fills = s.Fills[100:]
	}
	if nw.IsZero() {
		delete(s.Positions, base)
	}
}

// fillDir names a fill by the position before and after it.
func fillDir(old, nw decimal.Decimal) string {
	side := func(d decimal.Decimal) string {
		if d.IsNegative() {
			return "short"
		}
		return "long"
	}
	switch {
	case old.IsZero() || (old.Sign() == nw.Sign() && nw.Abs().GreaterThan(old.Abs())):
		return "open_" + side(nw)
	case nw.IsZero() || old.Sign() == nw.Sign():
		return "close_" + side(old)
	default:
		return "flip_" + side(nw)
	}
}

// matchResting executes resting limit / trigger orders whose price has been crossed.
func matchResting(s *PaperState, mids map[string]decimal.Decimal, m *Markets) {
	orders := s.Orders
	s.Orders = nil
	var remaining []PaperOrder
	for _, o := range orders {
		sp := m.Base(o.Base)
		var mid decimal.Decimal
		found := false
		if sp != nil {
			if px, ok := mids[sp.Symbol]; ok {
				mid, found = sp.CoinPx(px), true
			}
		}
		if !found {
			remaining = append(remaining, o)
			continue
		}
		var hit bool
		if o.TriggerPx != nil {
			t := *o.TriggerPx
			// TP sells fire above, SL sells fire below (mirror for buys).
			if (!o.Buy && o.TakeProfit) || (o.Buy && !o.TakeProfit) {
				hit = mid.GreaterThanOrEqual(t)
			} else {
				hit = mid.LessThanOrEqual(t)
			}
		} else {
			hit = (o.Buy && mid.LessThanOrEqual(o.Price)) || (!o.Buy && mid.GreaterThanOrEqual(o.Price))
		}
		if !hit {
			remaining = append(remaining, o)
			continue
		}
		pos := decimal.Zero
		if p, ok := s.Positions[o.Base]; ok {
			pos = p.Size
		}
		qty := o.Qty
		if o.ReduceOnly {
			reducible := decimal.Zero
			if (o.Buy && pos.IsNegative()) || (!o.Buy && pos.IsPositive()) {
				reducible = pos.Abs()
			}
			qty = util.MinD(qty, reducible)
		}
		if qty.IsPositive() {
			px, fee := o.Price, makerFee
			if o.TriggerPx != nil {
				px, fee = mid, takerFee
			}
			applyFill(s, o.Base, o.Buy, qty, px, fee, o.ClientID)
		}
	}
	s.Orders = remaining
}

func (p *Paper) Platform() model.Platform { return model.Paper }
func (p *Paper) Testnet() bool            { return false }
func (p *Paper) CanTrade() bool           { return true }
func (p *Paper) NeedsContracts() bool     { return true }

func (p *Paper) Contracts(ctx context.Context) ([]model.ContractSpec, error) {
	specs, err := p.feed.Contracts(ctx)
	if err != nil {
		return nil, err
	}
	for i := range specs {
		specs[i].Platform = model.Paper
		specs[i].MinNotional = decimal.Zero
	}
	return specs, nil
}

func (p *Paper) Snapshot(ctx context.Context, m *Markets, withOrders bool) (*model.AccountSnapshot, error) {
	mids, err := p.feed.AllMids(ctx)
	if err != nil {
		return nil, err
	}
	p.accrueFunding(ctx, mids, m)
	p.mu.Lock()
	defer p.mu.Unlock()
	before := len(p.st.Orders)
	matchResting(&p.st, mids, m)
	if len(p.st.Orders) != before {
		if err := p.persist(ctx); err != nil {
			return nil, err
		}
	}
	snap := &model.AccountSnapshot{Ts: util.NowMs(), Positions: []model.Position{}, Orders: []model.OpenOrder{}}
	margin, upnlTotal := decimal.Zero, decimal.Zero
	for base, ps := range p.st.Positions {
		spec := m.Base(base)
		mark := ps.Entry
		sym := base
		if spec != nil {
			sym = spec.Symbol
			if px, ok := mids[spec.Symbol]; ok {
				mark = spec.CoinPx(px)
			}
		}
		upnl := mark.Sub(ps.Entry).Mul(ps.Size)
		upnlTotal = upnlTotal.Add(upnl)
		margin = margin.Add(ps.Size.Mul(mark).Abs().Div(decimal.NewFromInt(int64(max(ps.Leverage, 1)))))
		snap.Positions = append(snap.Positions, model.Position{Base: base, Symbol: sym, Size: ps.Size, EntryPx: ps.Entry, MarkPx: mark, Leverage: decPtr(decimal.NewFromInt(int64(ps.Leverage))), Upnl: upnl})
	}
	snap.Equity = p.st.Cash.Add(upnlTotal)
	snap.Available = util.MaxD(snap.Equity.Sub(margin), decimal.Zero)
	if withOrders {
		for _, o := range p.st.Orders {
			kind := model.KindLimit
			if o.TriggerPx != nil {
				kind = model.KindStopMarket
				if o.TakeProfit {
					kind = model.KindTakeProfitMarket
				}
			}
			cid := o.ClientID
			snap.Orders = append(snap.Orders, model.OpenOrder{ID: o.ClientID, ClientID: &cid, Base: o.Base, Symbol: o.Base, Buy: o.Buy, Qty: o.Qty, OrigQty: o.OrigQty, Price: o.Price, TriggerPx: o.TriggerPx, Kind: kind, ReduceOnly: o.ReduceOnly})
		}
	}
	return snap, nil
}

func (p *Paper) BBO(ctx context.Context, spec *model.ContractSpec) (decimal.Decimal, decimal.Decimal, error) {
	return p.feed.BBO(ctx, spec)
}

func (p *Paper) Place(ctx context.Context, spec *model.ContractSpec, req *model.OrderRequest) (*model.OrderResult, error) {
	units := spec.ToUnits(req.Qty)
	if units.IsZero() {
		return nil, errs.Msg("数量低于最小步长")
	}
	qty := spec.UnitsToCoins(units)
	switch req.Type.Kind {
	case model.OrderMarket, model.OrderLimitIoc:
		bid, ask, err := p.feed.BBO(ctx, spec)
		if err != nil {
			return nil, err
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		px := bid
		if req.Buy {
			px = ask
		}
		if req.Type.Kind == model.OrderLimitIoc {
			if (req.Buy && px.GreaterThan(req.Type.Price)) || (!req.Buy && px.LessThan(req.Type.Price)) {
				return &model.OrderResult{OrderID: req.ClientID, Status: model.Rejected}, nil
			}
		}
		pos := decimal.Zero
		if ps, ok := p.st.Positions[spec.Base]; ok {
			pos = ps.Size
		}
		q := qty
		if req.ReduceOnly {
			reducible := decimal.Zero
			if (req.Buy && pos.IsNegative()) || (!req.Buy && pos.IsPositive()) {
				reducible = pos.Abs()
			}
			q = util.MinD(q, reducible)
			if q.IsZero() {
				return nil, &errs.Exchange{Code: "reduce_only", Msg: "只减仓订单会增加仓位"}
			}
		}
		applyFill(&p.st, spec.Base, req.Buy, q, px, takerFee, req.ClientID)
		if err := p.persist(ctx); err != nil {
			return nil, err
		}
		return &model.OrderResult{OrderID: req.ClientID, Status: model.Filled, Filled: q, AvgPx: decPtr(px)}, nil
	case model.OrderLimit:
		p.mu.Lock()
		defer p.mu.Unlock()
		p.st.Orders = append(p.st.Orders, PaperOrder{ClientID: req.ClientID, Base: spec.Base, Buy: req.Buy, Qty: qty, OrigQty: qty, Price: req.Type.Price, ReduceOnly: req.ReduceOnly})
		if err := p.persist(ctx); err != nil {
			return nil, err
		}
		return &model.OrderResult{OrderID: req.ClientID, Status: model.Open}, nil
	default:
		p.mu.Lock()
		defer p.mu.Unlock()
		tp := req.Type.TriggerPx
		p.st.Orders = append(p.st.Orders, PaperOrder{ClientID: req.ClientID, Base: spec.Base, Buy: req.Buy, Qty: qty, OrigQty: qty, TriggerPx: &tp, TakeProfit: req.Type.TakeProfit, ReduceOnly: req.ReduceOnly})
		if err := p.persist(ctx); err != nil {
			return nil, err
		}
		return &model.OrderResult{OrderID: req.ClientID, Status: model.Open}, nil
	}
}

func (p *Paper) Cancel(ctx context.Context, _ *model.ContractSpec, clientID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	kept := p.st.Orders[:0]
	for _, o := range p.st.Orders {
		if o.ClientID != clientID {
			kept = append(kept, o)
		}
	}
	p.st.Orders = kept
	return p.persist(ctx)
}

func (p *Paper) Query(_ context.Context, _ *model.ContractSpec, clientID string) (*model.OrderResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, o := range p.st.Orders {
		if o.ClientID == clientID {
			return &model.OrderResult{OrderID: o.ClientID, Status: model.Open, Filled: o.OrigQty.Sub(o.Qty)}, nil
		}
	}
	return nil, nil
}

// SetLeverage: paper accounts are always cross-margined; the mode is ignored.
func (p *Paper) SetLeverage(ctx context.Context, spec *model.ContractSpec, leverage uint32, _ bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if ps, ok := p.st.Positions[spec.Base]; ok && ps.Leverage != max(leverage, 1) {
		ps.Leverage = max(leverage, 1)
		return p.persist(ctx)
	}
	return nil
}

func (p *Paper) Info(context.Context) (*model.ConnectionInfo, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return &model.ConnectionInfo{
		Equity: p.st.Cash, Available: p.st.Cash, OneWay: true, MarginMode: "全仓（模拟）",
		Perms:       model.Permissions{Read: true, Trade: true, Withdraw: util.Ptr(false), Transfer: util.Ptr(false), Note: util.Ptr("模拟账户，不发真实订单")},
		MarginAsset: "USDT",
	}, nil
}

func (p *Paper) SetOneWay(context.Context) error            { return nil }
func (p *Paper) ServerTime(context.Context) (*int64, error) { return nil, nil }

// accrueFunding settles simulated hourly funding at the venue's current
// rates: longs pay a positive rate, shorts receive it. Missed hours (server
// down) are settled at the current rate, at most one day's worth.
func (p *Paper) accrueFunding(ctx context.Context, mids map[string]decimal.Decimal, m *Markets) {
	hour := util.NowMs() / 3_600_000
	p.mu.Lock()
	last, open := p.st.FundingHour, len(p.st.Positions) > 0
	if last >= hour {
		p.mu.Unlock()
		return
	}
	if last == 0 || !open {
		p.st.FundingHour = hour
		_ = p.persist(ctx)
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	rates, err := p.feed.FundingRates(ctx)
	if err != nil {
		return // retried on the next snapshot
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.st.FundingHour >= hour {
		return
	}
	for h := max(p.st.FundingHour+1, hour-23); h <= hour; h++ {
		for base, ps := range p.st.Positions {
			spec := m.Base(base)
			if spec == nil {
				continue
			}
			rate, ok := rates[spec.Symbol]
			mid, okm := mids[spec.Symbol]
			if !ok || !okm || rate.IsZero() {
				continue
			}
			amount := ps.Size.Mul(spec.CoinPx(mid)).Mul(rate).Neg()
			p.st.Cash = p.st.Cash.Add(amount)
			p.st.Funding = append(p.st.Funding, PaperFunding{Ts: h * 3_600_000, Base: base, Size: ps.Size, Amount: amount, Rate: rate})
		}
	}
	if len(p.st.Funding) > 2000 {
		p.st.Funding = p.st.Funding[len(p.st.Funding)-1500:]
	}
	p.st.FundingHour = hour
	_ = p.persist(ctx)
}

func (p *Paper) FillsSince(_ context.Context, _ *Markets, since int64) ([]Fill, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []Fill
	for i, f := range p.st.Fills {
		ts, err := strconv.ParseInt(f.Ts, 10, 64)
		if err != nil || ts < since {
			continue
		}
		out = append(out, Fill{ID: fmt.Sprintf("%s|%s|%s|%d", f.Ts, f.ClientID, f.Base, i%100), Ts: ts, Base: f.Base, Buy: f.Buy, Qty: f.Qty, Px: f.Px, Fee: f.Fee, Maker: f.Maker, ClientID: f.ClientID, Dir: f.Dir})
	}
	return out, nil
}

func (p *Paper) FundingSince(_ context.Context, _ *Markets, since int64) ([]FundingPay, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []FundingPay
	for _, f := range p.st.Funding {
		if f.Ts >= since {
			out = append(out, FundingPay{ID: fmt.Sprintf("%d|%s", f.Ts, f.Base), Ts: f.Ts, Base: f.Base, Size: f.Size, Amount: f.Amount, Rate: f.Rate})
		}
	}
	return out, nil
}
