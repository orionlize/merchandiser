package exchange

// Positions reconstructed from a lead trader's public fills.
//
// Binance traders can hide positions but their trade history stays public
// (measured ~2 min behind the real fill). We follow only what happens after
// an anchor time (when the source was added):
//   - each side (LONG / SHORT, or BOTH in one-way mode) is accumulated on its
//     own and never crosses zero, so closing a position opened before the
//     anchor (invisible to us) cannot conjure a reverse position;
//   - fills carry no id, so a fill's identity is all of its fields, counted
//     as a multiset (identical fills in the same millisecond do happen);
//   - only fills timestamped at or after the anchor count, by the venue's own
//     timestamp, not by when we first saw them.

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/util"
)

// Keys newer than lastTs - fillWindowMs are remembered for de-duplication.
const fillWindowMs = 15 * 60_000

type Fill struct {
	Time     int64
	Symbol   string
	Buy      bool
	PosSide  string // LONG / SHORT / BOTH
	Qty      decimal.Decimal
	Price    decimal.Decimal
	Realized decimal.Decimal
	Key      string
}

func ParseFill(v util.J) *Fill {
	t, ok := v.Get("time").Int()
	if !ok {
		return nil
	}
	symbol := v.JStr("symbol")
	side := v.JStr("side")
	qty := v.JDec("qty")
	if symbol == "" || !qty.IsPositive() || (side != "BUY" && side != "SELL") {
		return nil
	}
	ps := "BOTH"
	switch v.JStr("positionSide") {
	case "LONG":
		ps = "LONG"
	case "SHORT":
		ps = "SHORT"
	}
	price := v.JDec("price")
	realized := v.JDec("realizedProfit")
	key := fmt.Sprintf("%d|%s|%s|%s|%s|%s|%s|%s", t, symbol, side, ps, util.Fmt(qty), util.Fmt(price), util.Fmt(realized), util.Fmt(v.JDec("fee")))
	return &Fill{Time: t, Symbol: symbol, Buy: side == "BUY", PosSide: ps, Qty: qty, Price: price, Realized: realized, Key: key}
}

func keyTime(k string) int64 {
	t, _ := strconv.ParseInt(strings.SplitN(k, "|", 2)[0], 10, 64)
	return t
}

type Leg struct {
	// Signed size in venue units (LONG ≥ 0, SHORT ≤ 0, BOTH either).
	Qty   decimal.Decimal `json:"qty"`
	Entry decimal.Decimal `json:"entry"`
}

type FillState struct {
	// Only fills at or after this venue timestamp (ms) count.
	Anchor int64 `json:"anchor"`
	// Newest fill timestamp processed.
	LastTs int64 `json:"last_ts"`
	// Recently processed fill keys → count.
	Window map[string]uint32 `json:"window"`
	// "SYMBOL|SIDE" → leg.
	Legs map[string]*Leg `json:"legs"`
	// Symbol → latest fill price (stands in for the mark price).
	LastPx     map[string]decimal.Decimal `json:"last_px"`
	LastFillAt *int64                     `json:"last_fill_at"`
	Applied    uint64                     `json:"applied"`
}

func NewFillState(anchor int64) *FillState {
	s := &FillState{Anchor: anchor, LastTs: anchor}
	s.init()
	return s
}

func (s *FillState) init() {
	if s.Window == nil {
		s.Window = map[string]uint32{}
	}
	if s.Legs == nil {
		s.Legs = map[string]*Leg{}
	}
	if s.LastPx == nil {
		s.LastPx = map[string]decimal.Decimal{}
	}
}

// PageReachesKnown: whether this page reaches fills already processed (stop paging).
func (s *FillState) PageReachesKnown(page []Fill) bool {
	for _, f := range page {
		if f.Time < s.LastTs {
			return true
		}
		if _, ok := s.Window[f.Key]; ok {
			return true
		}
	}
	return false
}

// Ingest takes a contiguous newest-first slice of the trade history and
// returns how many fills were applied.
func (s *FillState) Ingest(fills []Fill) int {
	s.init()
	seen := map[string]uint32{}
	applied := 0
	// Older than the de-dup window: already processed (or pre-anchor).
	tooOld := s.LastTs - fillWindowMs
	// Oldest first so legs evolve in order.
	for i := len(fills) - 1; i >= 0; i-- {
		f := &fills[i]
		if f.Time < tooOld {
			continue
		}
		seen[f.Key]++
		if seen[f.Key] <= s.Window[f.Key] {
			continue
		}
		s.Window[f.Key]++
		if f.Time > s.LastTs {
			s.LastTs = f.Time
		}
		if f.Time < s.Anchor {
			continue
		}
		s.apply(f)
		applied++
	}
	cutoff := s.LastTs - fillWindowMs
	for k := range s.Window {
		if keyTime(k) < cutoff {
			delete(s.Window, k)
		}
	}
	return applied
}

func (s *FillState) apply(f *Fill) {
	s.LastPx[f.Symbol] = f.Price
	if s.LastFillAt == nil || f.Time > *s.LastFillAt {
		t := f.Time
		s.LastFillAt = &t
	}
	s.Applied++
	key := f.Symbol + "|" + f.PosSide
	leg, ok := s.Legs[key]
	if !ok {
		leg = &Leg{}
		s.Legs[key] = leg
	}
	dir := util.One
	if !f.Buy {
		dir = util.One.Neg()
	}
	var open, reduce decimal.Decimal
	switch f.PosSide {
	case "LONG":
		if f.Buy {
			open = f.Qty
		} else {
			reduce = f.Qty
		}
	case "SHORT":
		if f.Buy {
			reduce = f.Qty
		} else {
			open = f.Qty
		}
	default:
		// One-way: against the current side reduces; a fill with realised
		// PnL is a close (of something we may not see); otherwise opens.
		against := !leg.Qty.IsZero() && leg.Qty.Sign() != dir.Sign()
		switch {
		case against:
			r := util.MinD(f.Qty, leg.Qty.Abs())
			rest := f.Qty.Sub(r)
			// Flip remainder only when the fill realised nothing.
			if f.Realized.IsZero() {
				open = rest
			}
			reduce = r
		case leg.Qty.IsZero() && !f.Realized.IsZero():
		default:
			open = f.Qty
		}
	}
	if !reduce.IsZero() {
		r := util.MinD(reduce, leg.Qty.Abs())
		leg.Qty = leg.Qty.Sub(r.Mul(util.Signum(leg.Qty)))
		if leg.Qty.IsZero() {
			leg.Entry = decimal.Zero
		}
	}
	if !open.IsZero() {
		sign := dir
		switch f.PosSide {
		case "LONG":
			sign = util.One
		case "SHORT":
			sign = util.One.Neg()
		}
		old := leg.Qty.Abs()
		nw := old.Add(open)
		if old.IsZero() {
			leg.Entry = f.Price
		} else {
			leg.Entry = leg.Entry.Mul(old).Add(f.Price.Mul(open)).Div(nw)
		}
		leg.Qty = nw.Mul(sign)
	}
	if leg.Qty.IsZero() {
		delete(s.Legs, key)
	}
}

type ReconPos struct {
	Symbol             string
	Qty, Entry, LastPx decimal.Decimal
}

// Positions lists non-zero legs with their latest price.
func (s *FillState) Positions() []ReconPos {
	var out []ReconPos
	for k, l := range s.Legs {
		if l.Qty.IsZero() {
			continue
		}
		sym := strings.SplitN(k, "|", 2)[0]
		px, ok := s.LastPx[sym]
		if !ok {
			px = l.Entry
		}
		out = append(out, ReconPos{sym, l.Qty, l.Entry, px})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Symbol < out[j].Symbol })
	return out
}
