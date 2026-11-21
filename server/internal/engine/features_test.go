package engine

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

func dp(s string) *decimal.Decimal { v := d(s); return &v }

func TestAllocatedTarget(t *testing.T) {
	var r Rules
	if err := json.Unmarshal([]byte(`{"sizing":{"mode":"allocated","capital":"1000"},"leverage":{}}`), &r); err != nil {
		t.Fatal(err)
	}
	if !r.Sizing.K.Equal(util.One) || r.Leverage.Margin != "cross" || !r.Leverage.Cross() {
		t.Fatalf("defaults: %+v", r)
	}
	// Source holds 2 BTC on 100k equity; 1k capital → 0.02 BTC.
	got := Target(&r.Sizing, SizingInput{SrcSize: d("2"), SrcEquity: d("100000"), FollowerEquity: d("50000"), Capital: d("1000")})
	if !got.Equal(d("0.02")) {
		t.Fatalf("target %s", got)
	}
	if !Target(&r.Sizing, SizingInput{SrcSize: d("2"), SrcEquity: d("100000"), Capital: d("0")}).IsZero() {
		t.Fatal("zero capital should give zero target")
	}
}

func TestROEAndExit(t *testing.T) {
	// Long 10x, price +5% → ROE +50%.
	if roe := ROE(d("1"), d("100"), d("105"), d("10")); !roe.Equal(d("50")) {
		t.Fatalf("roe %s", roe)
	}
	// Short 4x, price +2.5% → −10%.
	if roe := ROE(d("-1"), d("100"), d("102.5"), d("4")); !roe.Equal(d("-10")) {
		t.Fatalf("short roe %s", roe)
	}
	tp := TPSL{Enabled: true, TPPct: dp("50"), SLPct: dp("25"), TrailActivatePct: dp("30"), TrailCallbackPct: dp("10")}
	cases := []struct {
		roe, peak, want string
	}{
		{"50", "50", "tp"},
		{"-25", "0", "sl"},
		{"20", "35", "trail"}, // peak 35 ≥ 30, fell 15 ≥ 10 points
		{"29", "29", ""},      // never activated
		{"26", "31", ""},      // 5 points below the peak
		{"21", "31", "trail"}, // 10 points below the peak
	}
	for _, c := range cases {
		if got := tp.Exit(d(c.roe), d(c.peak)); got != c.want {
			t.Errorf("Exit(%s, %s) = %q, want %q", c.roe, c.peak, got, c.want)
		}
	}
	off := TPSL{TPPct: dp("1")}
	if off.Active() || off.Exit(d("100"), d("100")) != "" {
		t.Fatal("disabled TP/SL must not fire")
	}
}

func TestLossLimitsPct(t *testing.T) {
	r := Risk{LossUnit: "pct", DailyLossLimit: dp("5"), TotalLossLimit: dp("20")}
	dl, tl := r.LossLimits(d("3000"))
	if dl == nil || !dl.Equal(d("150")) || tl == nil || !tl.Equal(d("600")) {
		t.Fatalf("limits %v %v", dl, tl)
	}
	if dl, tl := r.LossLimits(d("0")); dl != nil || tl != nil {
		t.Fatal("percent limits need a capital")
	}
	r.LossUnit = "usdt"
	if dl, _ := r.LossLimits(d("0")); dl == nil || !dl.Equal(d("5")) {
		t.Fatalf("usdt limit %v", dl)
	}
}

func TestLedgerTrips(t *testing.T) {
	e := newTestEngine(t)
	ctx := context.Background()
	// Open 1 @100, add 1 @110, sell 1 @120 (+15), sell 1 @90 (−15) → flat.
	e.LedgerFill("T", "acct", "BTC", d("1"), d("100"), FillTag{Reason: "sync"})
	e.LedgerFill("T", "acct", "BTC", d("1"), d("110"), FillTag{Reason: "sync"})
	e.LedgerFill("T", "acct", "BTC", d("-1"), d("120"), FillTag{Reason: "sync"})
	e.LedgerFill("T", "acct", "BTC", d("-1"), d("90"), FillTag{Reason: "sl", Note: "止损"})
	// Short 2 @50, then buy 3 @40: closes the short (+20) and opens long 1.
	e.LedgerFill("T", "acct", "ETH", d("-2"), d("50"), FillTag{Reason: "sync"})
	e.LedgerFill("T", "acct", "ETH", d("3"), d("40"), FillTag{Reason: "tp"})
	trips, err := store.Trips(ctx, e.DB, "WHERE task_id = ? ORDER BY id", "T")
	if err != nil {
		t.Fatal(err)
	}
	if len(trips) != 2 {
		t.Fatalf("trips %+v", trips)
	}
	b := trips[0]
	if b.Base != "BTC" || b.Side != "long" || b.EntryPx != "105" || b.ExitPx != "105" || util.Dec(b.Realized).Sign() != 0 || b.MaxSize != "2" || b.Reason != "sl" || b.Note == nil {
		t.Fatalf("btc trip %+v", b)
	}
	eth := trips[1]
	if eth.Side != "short" || eth.EntryPx != "50" || eth.ExitPx != "40" || !util.Dec(eth.Realized).Equal(d("20")) || eth.Reason != "tp" {
		t.Fatalf("eth trip %+v", eth)
	}
	// The flip left long 1 @40 with an open trip that survives a reload.
	e2 := New(ctx, e.DB, nil, NewBus())
	e2.LedgerFill("T", "acct", "ETH", d("-1"), d("44"), FillTag{Reason: "sync"})
	trips, _ = store.Trips(ctx, e.DB, "WHERE task_id = ? AND base = 'ETH' ORDER BY id", "T")
	if len(trips) != 2 || trips[1].Side != "long" || trips[1].EntryPx != "40" || !util.Dec(trips[1].Realized).Equal(d("4")) {
		t.Fatalf("after flip %+v", trips)
	}
	if got := e2.TaskRealizedOn("T", "acct"); !got.Equal(d("24")) {
		t.Fatalf("realized on acct %s", got)
	}
}
