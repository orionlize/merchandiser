package plaza

import (
	"fmt"
	"math"
	"testing"

	"merchandiser/server/internal/util"
)

func fillJ(t int64, coin, side, start, sz, closed string) util.J {
	j, err := util.ParseJ([]byte(fmt.Sprintf(`{"time":%d,"coin":%q,"side":%q,"startPosition":%q,"sz":%q,"closedPnl":%q}`, t, coin, side, start, sz, closed)))
	if err != nil {
		panic(err)
	}
	return j
}

func TestFillStatsRoundTrips(t *testing.T) {
	now := util.NowMs()
	h := int64(3600_000)
	fills := []util.J{
		// BTC: open 1 long, add, close → 4h round trip, one winning close.
		fillJ(now-10*h, "BTC", "B", "0", "1", "0"),
		fillJ(now-8*h, "BTC", "B", "1", "1", "0"),
		fillJ(now-6*h, "BTC", "A", "2", "2", "50"),
		// ETH: open short, flip long after 2h (losing close), close after 1h.
		fillJ(now-5*h, "ETH", "A", "0", "3", "0"),
		fillJ(now-3*h, "ETH", "B", "-3", "5", "-10"),
		fillJ(now-2*h, "ETH", "A", "2", "2", "5"),
	}
	a := &Analysis{}
	fillStats(a, fills, now-7*24*h)
	if a.AvgHoldSec == nil || math.Abs(*a.AvgHoldSec-float64(4+2+1)/3*3600) > 1 {
		t.Fatalf("avg hold %v", *a.AvgHoldSec/3600)
	}
	if a.WinRate == nil || math.Abs(*a.WinRate-2.0/3) > 1e-9 {
		t.Fatalf("win rate %v", a.WinRate)
	}
	if len(a.Coins) != 2 || a.TradesPerDay != math.Round(6.0/7*10)/10 {
		t.Fatalf("coins %v tpd %v", a.Coins, a.TradesPerDay)
	}
	if a.HFT() {
		t.Fatal("should not be HFT")
	}
}

func TestFillStatsNoRoundTripIsLongHold(t *testing.T) {
	now := util.NowMs()
	a := &Analysis{}
	fillStats(a, []util.J{fillJ(now-3600_000, "SOL", "B", "5", "1", "0")}, now-7*86_400_000)
	if a.AvgHoldSec == nil || *a.AvgHoldSec < 6*86400 {
		t.Fatalf("expected ≥ window span, got %v", a.AvgHoldSec)
	}
}

func TestDrawdownFreshAccount(t *testing.T) {
	// Account starts at 0, deposits 1000, gains 200, gives back 100.
	av := [][2]float64{{0, 0}, {1, 1000}, {2, 1200}, {3, 1100}}
	pnl := [][2]float64{{0, 0}, {1, 0}, {2, 200}, {3, 100}}
	dd, up := drawdown(av, pnl)
	if math.Abs(dd-100.0/1200) > 1e-9 {
		t.Fatalf("dd %v", dd)
	}
	if up != 0.5 {
		t.Fatalf("up share %v", up)
	}
	// Peak recorded while the account value was still ~0.
	av = [][2]float64{{0, 0}, {1, 0}, {2, 5000}}
	pnl = [][2]float64{{0, 0}, {1, 10}, {2, -490}}
	if dd, _ := drawdown(av, pnl); dd > 0.1 {
		t.Fatalf("tiny peak equity inflated dd to %v", dd)
	}
}

func TestScorePenalisesHFT(t *testing.T) {
	hold := 3 * 86400.0
	fast := 120.0
	mk := func(h *float64, tpd float64) *Wallet {
		return &Wallet{Perf: map[string]Perf{"30d": {Pnl: 1e5, Roi: 0.2}}, A: &Analysis{Equity: 5e6, MaxDD: map[string]float64{"30d": 0.05}, UpShare: map[string]float64{"30d": 0.7}, AvgHoldSec: h, TradesPerDay: tpd, Coins: []string{"BTC"}}}
	}
	good, _ := Score(mk(&hold, 3), "30d")
	hft, _ := Score(mk(&fast, 300), "30d")
	if good != 100 || hft > 30 {
		t.Fatalf("good %d hft %d", good, hft)
	}
	loss := mk(&hold, 3)
	loss.Perf["30d"] = Perf{Pnl: -1, Roi: -0.01}
	if s, _ := Score(loss, "30d"); s >= good*6/10+1 {
		t.Fatalf("losing window not penalised: %d", s)
	}
}
