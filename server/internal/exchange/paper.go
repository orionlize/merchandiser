package exchange

// Paper account: virtual fills against live Hyperliquid prices. Nothing is
// sent to any venue. State is persisted in SQLite after every change.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
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

// PaperFill serialises as [ts, base, buy, qty, px, fee].
type PaperFill struct {
	Ts           string
	Base         string
	Buy          bool
	Qty, Px, Fee decimal.Decimal
}

func (f PaperFill) MarshalJSON() ([]byte, error) {
	return json.Marshal([]any{f.Ts, f.Base, f.Buy, f.Qty, f.Px, f.Fee})
}

func (f *PaperFill) UnmarshalJSON(b []byte) error {
	var a []json.RawMessage
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	if len(a) != 6 {
		return fmt.Errorf("paper fill: want 6 fields")
	}
	_ = json.Unmarshal(a[0], &f.Ts)
	_ = json.Unmarshal(a[1], &f.Base)
	_ = json.Unmarshal(a[2], &f.Buy)
	_ = json.Unmarshal(a[3], &f.Qty)
	_ = json.Unmarshal(a[4], &f.Px)
	_ = json.Unmarshal(a[5], &f.Fee)
	return nil
}

type PaperState struct {
	Cash      decimal.Decimal      `json:"cash"`
	Positions map[string]*PaperPos `json:"positions"`
	Orders    []PaperOrder         `json:"orders"`
	Fills     []PaperFill          `json:"fills"`
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

func applyFill(s *PaperState, base string, buy bool, qty, px, feeRate decimal.Decimal) {
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
	s.Fills = append(s.Fills, PaperFill{Ts: fmt.Sprint(util.NowMs()), Base: base, Buy: buy, Qty: qty, Px: px, Fee: fee})
	if len(s.Fills) > 500 {
		s.Fills = s.Fills[100:]
	}
	if nw.IsZero() {
		delete(s.Positions, base)
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
			applyFill(s, o.Base, o.Buy, qty, px, fee)
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
		applyFill(&p.st, spec.Base, req.Buy, q, px, takerFee)
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

func (p *Paper) SetLeverage(_ context.Context, spec *model.ContractSpec, leverage uint32) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if ps, ok := p.st.Positions[spec.Base]; ok {
		ps.Leverage = max(leverage, 1)
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
