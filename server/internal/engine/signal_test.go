package engine

import (
	"testing"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/model"
)

func TestSignalSource(t *testing.T) {
	d := decimal.RequireFromString
	pos := func(size, entry, mark string) []model.Position {
		if size == "0" {
			return nil
		}
		return []model.Position{{Base: "BTC", Size: d(size), EntryPx: d(entry), MarkPx: d(mark)}}
	}
	// Positions only: add 1 → 3 with entry 100 → 110 means 2 filled at 115.
	prev := &model.AccountSnapshot{Equity: d("1000"), Positions: pos("1", "100", "100")}
	cur := &model.AccountSnapshot{Equity: d("1000"), Positions: pos("3", "110", "116")}
	s := signalSource(prev, cur, "BTC")
	if *s.SrcPx != "115" || *s.SrcBasis != "positions" || *s.SrcEntry != "100" || s.SrcTs != nil {
		t.Fatalf("add: %+v", s)
	}
	// Reduce from positions: mark at detection.
	cur = &model.AccountSnapshot{Equity: d("1000"), Positions: pos("0.5", "100", "120")}
	if s := signalSource(prev, cur, "BTC"); *s.SrcPx != "120" {
		t.Fatalf("reduce: %s", *s.SrcPx)
	}
	// With fill totals: VWAP, last fill time and realised PnL of the gap.
	prev.Trades = map[string]model.TradeCum{"BTC": {Qty: d("1"), Notional: d("100"), LastTs: 1}}
	cur = &model.AccountSnapshot{Equity: d("1000"), Positions: pos("0", "", ""),
		Trades: map[string]model.TradeCum{"BTC": {Qty: d("2"), Notional: d("212"), Realized: d("12"), LastTs: 99}}}
	s = signalSource(prev, cur, "BTC")
	if *s.SrcPx != "112" || *s.SrcBasis != "fills" || *s.SrcTs != 99 || *s.SrcRealized != "12" {
		t.Fatalf("fills: %+v", s)
	}
}
