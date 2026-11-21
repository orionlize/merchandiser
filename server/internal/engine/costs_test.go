package engine

import (
	"context"
	"encoding/json"
	"testing"

	"merchandiser/server/internal/exchange"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// Fees of a task's own orders are booked to it and its round trip; fills of
// orders it did not place are not; net PnL subtracts fees and adds funding.
func TestCostsBooking(t *testing.T) {
	e := newTestEngine(t)
	ctx := context.Background()
	now := util.NowMs()
	orderID, err := store.InsertOrder(ctx, e.DB, &store.OrderRow{TaskID: "A", ConnectionID: util.Ptr("acct"), Base: "BTC", ClientID: util.Ptr("cid1"), Status: "filled", Purpose: "sync"})
	if err != nil {
		t.Fatal(err)
	}
	e.LedgerFill("A", "acct", "BTC", d("1"), d("100"), FillTag{})
	orders, err := store.OrdersByClientID(ctx, e.DB, "acct", 0)
	if err != nil || orders["cid1"].ID != orderID {
		t.Fatalf("orders %v %v", orders, err)
	}
	fill := exchange.Fill{ID: "t1", Ts: now, Base: "BTC", Buy: true, Qty: d("1"), Px: d("100"), Fee: d("0.045"), ClientID: "cid1"}
	if !e.bookFee(ctx, "acct", &fill, orders) {
		t.Fatal("own fill not booked")
	}
	if e.bookFee(ctx, "acct", &fill, orders) {
		t.Fatal("fee booked twice")
	}
	manual := exchange.Fill{ID: "t2", Ts: now, Base: "BTC", Qty: d("1"), Px: d("100"), Fee: d("1"), ClientID: "other"}
	if e.bookFee(ctx, "acct", &manual, orders) {
		t.Fatal("manual fill booked")
	}
	// Second task holds 3 BTC on the same account; the account holds 5
	// (1 manual): funding of −0.5 on 5 BTC splits 0.1 / 0.3, the rest is
	// nobody's.
	e.LedgerFill("B", "acct", "BTC", d("3"), d("100"), FillTag{})
	pay := exchange.FundingPay{ID: "h1", Ts: now, Base: "BTC", Size: d("5"), Amount: d("-0.5"), Rate: d("0.001")}
	if n := e.bookFunding(ctx, "acct", &pay); n != 2 {
		t.Fatalf("funding booked to %d tasks", n)
	}
	e.RememberSnapshot("acct", snap(now, "BTC", "5", "110"))
	b, ok := e.TaskPnlBreakdown("A")
	if !ok || !b.Upnl.Equal(d("10")) || !b.Fees.Equal(d("0.045")) || !b.Funding.Equal(d("-0.1")) || !b.Net().Equal(d("9.855")) {
		t.Fatalf("A breakdown %+v net %s", b, b.Net())
	}
	if pb, _ := e.TaskPnl("B"); !pb.Equal(d("29.7")) {
		t.Fatalf("B pnl %s", pb)
	}
	tot, err := store.TaskCostTotals(ctx, e.DB, "A", 0)
	if err != nil || tot.Fills != 1 || tot.Fees != 0.045 || tot.FundingOut != -0.1 {
		t.Fatalf("totals %+v %v", tot, err)
	}
	// The closing fill's fee settles after the trip was recorded: it goes to
	// that trip, which reports gross and costs separately.
	e.LedgerFill("A", "acct", "BTC", d("-1"), d("110"), FillTag{Reason: "close"})
	e.LedgerCost("A", "acct", "BTC", "fee", d("0.05"), util.NowMs()-1000)
	trips, err := store.Trips(ctx, e.DB, "WHERE task_id = ?", "A")
	if err != nil || len(trips) != 1 {
		t.Fatalf("trips %v %v", trips, err)
	}
	tr := trips[0]
	if !util.Dec(tr.Realized).Equal(d("10")) || !util.Dec(tr.Fees).Equal(d("0.095")) || !util.Dec(tr.Funding).Equal(d("-0.1")) {
		t.Fatalf("trip %+v", tr)
	}
	// Persisted and reloaded.
	e2 := New(ctx, e.DB, nil, NewBus())
	if b2, _ := e2.TaskPnlBreakdown("A"); !b2.Fees.Equal(d("0.095")) || !b2.Funding.Equal(d("-0.1")) {
		t.Fatalf("reloaded %+v", b2)
	}
}

func TestWatchRules(t *testing.T) {
	var r Rules
	if err := json.Unmarshal([]byte(`{"mode":"watch","watch":{"reduce":false,"min_notional":"5000"}}`), &r); err != nil {
		t.Fatal(err)
	}
	if !r.Watching() || !r.Watch.Open || !r.Watch.Add || r.Watch.Reduce || !r.Watch.Close {
		t.Fatalf("watch defaults %+v", r.Watch)
	}
	cases := []struct {
		kind, notional string
		want           bool
	}{
		{"open", "1", true}, {"close", "1", true}, {"flip", "1", true},
		{"add", "4999", false}, {"add", "5000", true}, {"reduce", "9000", false},
	}
	for _, c := range cases {
		if got := r.Watch.Wants(c.kind, d(c.notional)); got != c.want {
			t.Errorf("Wants(%s, %s) = %v", c.kind, c.notional, got)
		}
	}
	var def Rules
	_ = json.Unmarshal([]byte(`{}`), &def)
	if def.Watching() || def.Mode != "copy" {
		t.Fatalf("default mode %q", def.Mode)
	}
}

func TestSourceDrawdown(t *testing.T) {
	// Peak PnL 50k at 1M equity; now 30k → 2 %.
	if dd := SourceDrawdown(d("50000"), d("1000000"), d("30000")); !dd.Equal(d("2")) {
		t.Fatalf("dd %s", dd)
	}
	if !SourceDrawdown(d("50000"), d("1000000"), d("60000")).IsZero() || !SourceDrawdown(d("1"), d("0"), d("0")).IsZero() {
		t.Fatal("no drawdown above the peak or without equity")
	}
	var risk Risk
	_ = json.Unmarshal([]byte(`{"source_dd_pct":"20"}`), &risk)
	if risk.SourceDDAction != "pause" || !risk.SourceDDPct.Equal(d("20")) {
		t.Fatalf("risk %+v", risk)
	}
}
