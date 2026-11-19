package exchange

import (
	"testing"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/util"
)

func pj(t *testing.T, s string) util.J {
	v, err := util.ParseJ([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestParseHistPos(t *testing.T) {
	h := ParseHistPos(pj(t, `{"symbol":"MUUSDT","side":"Long","status":"All Closed","closed":1795016431494,"leverage":"1"}`))
	if h == nil || h.Side != "LONG" || h.Closed != 1795016431494 || !h.Leverage.Equal(decimal.NewFromInt(1)) {
		t.Fatalf("got %+v", h)
	}
	if ParseHistPos(pj(t, `{"symbol":"MUUSDT","side":"Long","status":"Partially Closed","closed":1}`)) != nil {
		t.Error("partially closed position must be ignored")
	}
}

func TestCorrectZeroesMissedClose(t *testing.T) {
	s := NewFillState(0)
	// Long opened at 10 s; the closing fills were missed.
	s.Ingest(page(mkFill(t, 10_000, "BTCUSDT", "BUY", "LONG", "1", "60000", "0")))
	got := s.Correct([]HistPos{{Symbol: "BTCUSDT", Side: "LONG", Closed: 20_500}})
	if len(got) != 1 || len(s.Positions()) != 0 || s.Corrected != 1 {
		t.Fatalf("corrected %v, positions %v", got, s.Positions())
	}
	// Idempotent.
	if got := s.Correct([]HistPos{{Symbol: "BTCUSDT", Side: "LONG", Closed: 20_500}}); len(got) != 0 {
		t.Errorf("second pass corrected %v", got)
	}
}

func TestCorrectKeepsReopen(t *testing.T) {
	s := NewFillState(0)
	// Reopened in the same second as the close (fill times are whole seconds).
	s.Ingest(page(mkFill(t, 20_000, "BTCUSDT", "BUY", "LONG", "1", "60000", "0")))
	// And a short that the long's close says nothing about.
	s.Ingest(page(mkFill(t, 21_000, "ETHUSDT", "SELL", "SHORT", "2", "3000", "0")))
	hist := []HistPos{
		{Symbol: "BTCUSDT", Side: "LONG", Closed: 20_500},
		{Symbol: "ETHUSDT", Side: "LONG", Closed: 30_000},
	}
	if got := s.Correct(hist); len(got) != 0 {
		t.Fatalf("corrected %v", got)
	}
	if len(s.Positions()) != 2 {
		t.Fatalf("positions %v", s.Positions())
	}
}

func TestCorrectOneWayBySign(t *testing.T) {
	s := NewFillState(0)
	s.Ingest(page(mkFill(t, 10_000, "SOLUSDT", "SELL", "BOTH", "10", "70", "0")))
	if got := s.Correct([]HistPos{{Symbol: "SOLUSDT", Side: "LONG", Closed: 50_000}}); len(got) != 0 {
		t.Fatalf("long close zeroed a short: %v", got)
	}
	if got := s.Correct([]HistPos{{Symbol: "SOLUSDT", Side: "SHORT", Closed: 50_000}}); len(got) != 1 {
		t.Fatalf("short close not applied: %v", got)
	}
}

func TestCorrectSkipsBeforeAnchorAndLegacyLegs(t *testing.T) {
	s := NewFillState(100_000)
	s.Ingest(page(mkFill(t, 110_000, "BTCUSDT", "BUY", "LONG", "1", "60000", "0")))
	if got := s.Correct([]HistPos{{Symbol: "BTCUSDT", Side: "LONG", Closed: 90_000}}); len(got) != 0 {
		t.Fatalf("pre-anchor close applied: %v", got)
	}
	s.Legs["BTCUSDT|LONG"].At = 0
	if got := s.Correct([]HistPos{{Symbol: "BTCUSDT", Side: "LONG", Closed: 200_000}}); len(got) != 0 {
		t.Fatalf("legacy leg corrected: %v", got)
	}
}

func TestHistLeverageLatestWins(t *testing.T) {
	m := HistLeverage([]HistPos{
		{Symbol: "BTCUSDT", Closed: 2, Leverage: decimal.NewFromInt(10)},
		{Symbol: "BTCUSDT", Closed: 1, Leverage: decimal.NewFromInt(5)},
	})
	if !m["BTCUSDT"].Equal(decimal.NewFromInt(10)) {
		t.Errorf("got %v", m)
	}
}
