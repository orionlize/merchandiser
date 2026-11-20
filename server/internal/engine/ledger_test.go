package engine

import (
	"context"
	"testing"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/model"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

var d = decimal.RequireFromString

func TestLedgerApplyFill(t *testing.T) {
	p := &ledgerPos{}
	p.applyFill(d("2"), d("100"))  // long 2 @100
	p.applyFill(d("2"), d("110"))  // long 4 @105
	p.applyFill(d("-1"), d("120")) // close 1: +15
	if !p.size.Equal(d("3")) || !p.avgPx.Equal(d("105")) || !p.realized.Equal(d("15")) {
		t.Fatalf("after reduce: %+v", p)
	}
	p.applyFill(d("-5"), d("90")) // close 3 (−45) and open short 2 @90
	if !p.size.Equal(d("-2")) || !p.avgPx.Equal(d("90")) || !p.realized.Equal(d("-30")) {
		t.Fatalf("after flip: %+v", p)
	}
	p.applyFill(d("2"), d("80")) // cover: +20
	if !p.size.IsZero() || !p.avgPx.IsZero() || !p.realized.Equal(d("-10")) {
		t.Fatalf("after cover: %+v", p)
	}
}

func newTestEngine(t *testing.T) *Engine {
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return New(context.Background(), db, nil, NewBus())
}

func snap(ts int64, base, size, mark string) *model.AccountSnapshot {
	s := &model.AccountSnapshot{Ts: ts}
	if size != "0" {
		s.Positions = []model.Position{{Base: base, Size: d(size), MarkPx: d(mark)}}
	}
	return s
}

// Two tasks on one account: each sees only its own share, and PnL splits.
func TestLedgerSharedAccount(t *testing.T) {
	e := newTestEngine(t)
	e.LedgerFill("A", "acct", "BTC", d("1"), d("100"))
	e.LedgerFill("B", "acct", "BTC", d("3"), d("110"))
	if !e.Held("A", "acct", "BTC").Equal(d("1")) || !e.Held("B", "acct", "BTC").Equal(d("3")) {
		t.Fatal("shares")
	}
	e.RememberSnapshot("acct", snap(util.NowMs(), "BTC", "4", "120"))
	a, _ := e.TaskPnl("A")
	b, _ := e.TaskPnl("B")
	if !a.Equal(d("20")) || !b.Equal(d("30")) {
		t.Fatalf("pnl A=%s B=%s", a, b)
	}
	// Survives a restart.
	e2 := New(context.Background(), e.DB, nil, NewBus())
	if !e2.Held("B", "acct", "BTC").Equal(d("3")) {
		t.Fatal("reload")
	}
}

// Account holding less than the shares (liquidation / manual close) scales
// them down, but only once the shortfall persists past a fresh fill.
func TestLedgerShortfall(t *testing.T) {
	e := newTestEngine(t)
	e.LedgerFill("A", "acct", "ETH", d("1"), d("100"))
	e.LedgerFill("B", "acct", "ETH", d("3"), d("100"))
	px := func(string) decimal.Decimal { return d("90") }
	now := util.NowMs()
	// Right after a fill: ignored.
	e.reconcileLedger("acct", snap(now, "ETH", "2", "90"), px)
	if !e.Held("B", "acct", "ETH").Equal(d("3")) {
		t.Fatal("cut too early")
	}
	later := now + shortfallMs
	e.reconcileLedger("acct", snap(later, "ETH", "2", "90"), px)
	if !e.Held("B", "acct", "ETH").Equal(d("3")) {
		t.Fatal("cut on first sight")
	}
	e.reconcileLedger("acct", snap(later+shortfallMs, "ETH", "2", "90"), px)
	if !e.Held("A", "acct", "ETH").Equal(d("0.5")) || !e.Held("B", "acct", "ETH").Equal(d("1.5")) {
		t.Fatalf("cut: A=%s B=%s", e.Held("A", "acct", "ETH"), e.Held("B", "acct", "ETH"))
	}
	e.RememberSnapshot("acct", snap(later+shortfallMs, "ETH", "2", "90"))
	if b, _ := e.TaskPnl("B"); !b.Equal(d("-30")) { // 1.5 cut at −10 realised, 1.5 held at −10 (mark 90)
		t.Fatalf("pnl B=%s", b)
	}
	// More on the account than the shares (manual extra): untouched.
	e.reconcileLedger("acct", snap(later+3*shortfallMs, "ETH", "5", "90"), px)
	if !e.Held("B", "acct", "ETH").Equal(d("1.5")) {
		t.Fatal("grew")
	}
}

// Seeding a pre-existing position never takes what other tasks own.
func TestLedgerClaimShare(t *testing.T) {
	e := newTestEngine(t)
	e.LedgerFill("A", "acct", "SOL", d("2"), d("10"))
	e.claimShare("B", "acct", "SOL", d("5"), d("3"), d("10")) // account 3, A owns 2
	if !e.Held("B", "acct", "SOL").Equal(d("1")) {
		t.Fatalf("B=%s", e.Held("B", "acct", "SOL"))
	}
	e.claimShare("C", "acct", "SOL", d("-1"), d("3"), d("10")) // opposite side: nothing
	if !e.Held("C", "acct", "SOL").IsZero() {
		t.Fatal("C")
	}
}

func TestReduceOnly(t *testing.T) {
	// Task long 1 on an account net short 1 (another task short 2): selling
	// the task's long grows the account's short, so it can't be reduce-only.
	if reduceOnly(d("-1"), d("1"), d("1")) {
		t.Fatal("must not be reduce-only")
	}
	if !reduceOnly(d("3"), d("1"), d("1")) {
		t.Fatal("should be reduce-only")
	}
}
