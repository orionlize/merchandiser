package engine

import (
	"github.com/shopspring/decimal"

	"merchandiser/server/internal/model"
	"merchandiser/server/internal/util"
)

// PositionLive is one open position on a follower account, as shown in the UI.
type PositionLive struct {
	ConnectionID string `json:"connection_id"`
	Alias        string `json:"alias"`
	Base         string `json:"base"`
	Symbol       string `json:"symbol"`
	// Signed size in coins, positive = long.
	Size     string  `json:"size"`
	EntryPx  string  `json:"entry_px"`
	MarkPx   string  `json:"mark_px"`
	Leverage *string `json:"leverage"`
	Notional string  `json:"notional"`
	// Initial margin estimate (notional / leverage); nil without leverage.
	Margin *string `json:"margin"`
	Upnl   string  `json:"upnl"`
	// Price move since entry in the position's favour, percent.
	PnlPct *string `json:"pnl_pct"`
	// Upnl over margin, percent.
	RoePct *string `json:"roe_pct"`
	// The source's position in the same coin (task view only).
	SrcSize     *string `json:"src_size,omitempty"`
	SrcEntryPx  *string `json:"src_entry_px,omitempty"`
	SrcLeverage *string `json:"src_leverage,omitempty"`
}

func newPositionLive(connID, alias string, p *model.Position) PositionLive {
	notional := p.Size.Mul(p.MarkPx).Abs()
	out := PositionLive{
		ConnectionID: connID, Alias: alias, Base: p.Base, Symbol: p.Symbol,
		Size: util.Fmt(p.Size), EntryPx: util.Fmt(p.EntryPx), MarkPx: util.Fmt(p.MarkPx),
		Notional: util.Fmt(notional.RoundBank(2)), Upnl: util.Fmt(p.Upnl.RoundBank(2)),
	}
	if p.EntryPx.IsPositive() && p.MarkPx.IsPositive() {
		pct := p.MarkPx.Sub(p.EntryPx).Div(p.EntryPx).Mul(util.Hundred)
		if p.Size.IsNegative() {
			pct = pct.Neg()
		}
		out.PnlPct = util.Ptr(util.Fmt(pct.RoundBank(2)))
	}
	if p.Leverage != nil && p.Leverage.IsPositive() {
		out.Leverage = util.Ptr(util.Fmt(p.Leverage.RoundBank(2)))
		margin := notional.Div(*p.Leverage)
		out.Margin = util.Ptr(util.Fmt(margin.RoundBank(2)))
		if margin.IsPositive() {
			out.RoePct = util.Ptr(util.Fmt(p.Upnl.Div(margin).Mul(util.Hundred).RoundBank(2)))
		}
	}
	return out
}

// PositionsOf lists the non-zero positions of a snapshot.
func PositionsOf(connID, alias string, s *model.AccountSnapshot) []PositionLive {
	out := []PositionLive{}
	if s == nil {
		return out
	}
	for i := range s.Positions {
		if s.Positions[i].Size.IsZero() {
			continue
		}
		out = append(out, newPositionLive(connID, alias, &s.Positions[i]))
	}
	return out
}

// RememberSnapshot caches the freshest snapshot seen for an account, so the
// overview can list positions without hitting the venue.
func (e *Engine) RememberSnapshot(connID string, s *model.AccountSnapshot) {
	if s == nil {
		return
	}
	e.snapMu.Lock()
	defer e.snapMu.Unlock()
	if old, ok := e.snaps[connID]; ok && old.Ts > s.Ts {
		return
	}
	e.snaps[connID] = s
}

// LatestSnapshot is the freshest cached snapshot of an account (nil if none).
func (e *Engine) LatestSnapshot(connID string) *model.AccountSnapshot {
	e.snapMu.RLock()
	defer e.snapMu.RUnlock()
	return e.snaps[connID]
}

func (e *Engine) forgetSnapshot(connID string) {
	e.snapMu.Lock()
	delete(e.snaps, connID)
	e.snapMu.Unlock()
}

func srcPosition(src *model.AccountSnapshot, base string) *model.Position {
	var out *model.Position
	size := decimal.Zero
	for i := range src.Positions {
		if src.Positions[i].Base == base && !src.Positions[i].Size.IsZero() {
			out = &src.Positions[i]
			size = size.Add(out.Size)
		}
	}
	if out == nil {
		return nil
	}
	cp := *out
	cp.Size = size
	return &cp
}
