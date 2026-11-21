package plaza

import (
	"math"
	"testing"
	"time"
)

func TestSimulate(t *testing.T) {
	h := int64(3600_000)
	from := int64(1_000_000_000_000)
	now := from + 100*h
	d := &simData{
		from: from,
		// Source equity 100k throughout; trader PnL +10k over the window.
		av:  [][2]float64{{float64(from), 100_000}},
		pnl: [][2]float64{{float64(from), 0}, {float64(now), 10_000}},
		fills: []simFill{
			// Builder-dex perp: not tradable by the engine, left out.
			{t: from + h/2, coin: "xyz:ANT", start: 0, sz: 100, px: 1},
			// ETH was already held at the window start: ignored until flat.
			{t: from + h, coin: "ETH", start: 5, sz: 1, px: 3000},
			// BTC: open 1 @100k → follower 0.01 BTC (1000 USDT) on 1000 capital.
			{t: from + 2*h, coin: "BTC", start: 0, sz: 1, px: 100_000},
			// Tiny add: 0.001 BTC → follower 0.00001 (1 USDT) < 10 → skipped.
			{t: from + 3*h, coin: "BTC", start: 1, sz: 0.001, px: 100_000},
			// Close everything @110k: +10% on 0.01001 target… follower holds 0.01.
			{t: from + 4*h, coin: "BTC", start: 1.001, sz: -1.001, px: 110_000},
			// ETH goes flat: followed from now on (nothing to copy yet).
			{t: from + 5*h, coin: "ETH", start: 6, sz: -6, px: 3100},
		},
		mids: map[string]float64{},
	}
	r := simulate(d, "7d", "new_only", 1000, 0, now)
	if r.Trades != 2 || r.Skipped != 1 {
		t.Fatalf("trades %d skipped %d", r.Trades, r.Skipped)
	}
	fees := 0.01*100_000*takerFee + 0.01*110_000*takerFee
	if math.Abs(r.Pnl-(100-fees)) > 1e-6 {
		t.Fatalf("pnl %v want %v", r.Pnl, 100-fees)
	}
	if math.Abs(r.TraderRoi-0.1) > 1e-9 || r.Efficiency == nil {
		t.Fatalf("trader roi %v eff %v", r.TraderRoi, r.Efficiency)
	}
	if len(r.Ignored) != 0 {
		t.Fatalf("ETH should be followed again after going flat: %v", r.Ignored)
	}
	if len(r.Unsupported) != 1 || r.Unsupported[0] != "xyz:ANT" {
		t.Fatalf("unsupported %v", r.Unsupported)
	}
	if r.SuggestCapital == nil || *r.SuggestCapital < 10_000 {
		t.Fatalf("suggest %v", r.SuggestCapital)
	}
	// Slippage costs money.
	r2 := simulate(d, "7d", "new_only", 1000, 10, now)
	if !(r2.Pnl < r.Pnl) || r2.SlipCost <= 0 {
		t.Fatalf("slippage pnl %v vs %v", r2.Pnl, r.Pnl)
	}
	// sync_existing: ETH held at the start (5 → 0.05 on 1000 / 100k) is
	// bought in at the first price seen, then the add and the close follow.
	r3 := simulate(d, "7d", "sync_existing", 1000, 0, now)
	if len(r3.Synced) != 1 || r3.Synced[0] != "ETH" || r3.Trades != 5 {
		t.Fatalf("synced %v trades %d", r3.Synced, r3.Trades)
	}
	ethFees := (0.05*3000 + 0.01*3000 + 0.06*3100) * takerFee
	if math.Abs(r3.Pnl-(r.Pnl+6-ethFees)) > 1e-6 {
		t.Fatalf("sync pnl %v want %v", r3.Pnl, r.Pnl+6-ethFees)
	}
}

func TestSimEntryView(t *testing.T) {
	at := time.UnixMilli(1_800_000_000_000)
	day := int64(86_400_000)
	now := at.UnixMilli()
	e := &simEntry{
		at:   at,
		from: now - 30*day,
		av:   map[string][][2]float64{"7d": {{0, 1}}, "30d": {{0, 2}}},
		pnl:  map[string][][2]float64{},
		fills: []simFill{
			{t: now - 20*day, coin: "BTC"},
			{t: now - 7*day - 1, coin: "BTC"},
			{t: now - 7*day, coin: "ETH"},
			{t: now - day, coin: "SOL"},
		},
	}
	v := e.view("7d")
	if v.from != now-7*day || len(v.fills) != 2 || v.fills[0].coin != "ETH" || v.truncated || v.av[0][1] != 1 {
		t.Fatalf("7d view: from=%d fills=%v truncated=%v", v.from, v.fills, v.truncated)
	}
	if v := e.view("30d"); len(v.fills) != 4 || v.truncated || v.av[0][1] != 2 {
		t.Fatalf("30d view: %v %v", v.fills, v.truncated)
	}
	// Capped history that only reaches back 10 days: 30d is truncated to it.
	e.from, e.capped = now-10*day, true
	if v := e.view("30d"); v.from != now-10*day || len(v.fills) != 3 || !v.truncated {
		t.Fatalf("capped 30d view: from=%d fills=%d truncated=%v", v.from, len(v.fills), v.truncated)
	}
	if v := e.view("7d"); v.truncated {
		t.Fatal("7d is fully covered by a 10-day history")
	}
}
