package exchange

import (
	"testing"

	"github.com/shopspring/decimal"
)

func TestFillStateCum(t *testing.T) {
	d := decimal.RequireFromString
	s := NewFillState(0)
	// Newest first, as the venue lists them.
	s.Ingest([]Fill{
		{Time: 20, Symbol: "BTCUSDT", Buy: false, PosSide: "BOTH", Qty: d("1"), Price: d("110"), Realized: d("10"), Key: "b"},
		{Time: 10, Symbol: "BTCUSDT", Buy: true, PosSide: "BOTH", Qty: d("2"), Price: d("100"), Key: "a"},
	})
	c := s.Cum["BTCUSDT"]
	if c == nil || !c.Qty.Equal(d("3")) || !c.Notional.Equal(d("310")) || !c.Realized.Equal(d("10")) || c.LastTs != 20 {
		t.Fatalf("cum %+v", c)
	}
}
