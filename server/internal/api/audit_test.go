package api

import (
	"context"
	"encoding/csv"
	"strings"
	"testing"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/engine"
	"merchandiser/server/internal/store"
)

func TestFollowerBookReplay(t *testing.T) {
	d := decimal.RequireFromString
	b := &followerBook{}
	b.apply(true, d("1"), d("100"))
	b.apply(true, d("1"), d("110"))
	if !b.avg.Equal(d("105")) || !b.pos.Equal(d("2")) {
		t.Fatalf("add: pos %s avg %s", b.pos, b.avg)
	}
	if r := b.apply(false, d("0.5"), d("115")); !r.Equal(d("5")) {
		t.Fatalf("reduce realised %s", r)
	}
	// Flip: closes 1.5 long, opens 0.5 short at the fill price.
	if r := b.apply(false, d("2"), d("100")); !r.Equal(d("-7.5")) || !b.pos.Equal(d("-0.5")) || !b.avg.Equal(d("100")) {
		t.Fatalf("flip: realised %s pos %s avg %s", r, b.pos, b.avg)
	}
}

func TestExportTaskAudit(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	t0 := int64(1_700_000_000_000)
	exec("INSERT INTO connections (id, platform, alias, created_at) VALUES ('c1','paper','main',0)")
	exec("INSERT INTO sources (id, kind, name, platform, created_at) VALUES ('s1','lead_trader','L','binance',0)")
	exec("INSERT INTO tasks (id, name, source_id, status, rules_json, risk_json, created_at) VALUES ('t1','T','s1','running','{}','{}',0)")
	exec("INSERT INTO task_followers (task_id, connection_id) VALUES ('t1','c1')")
	exec("INSERT INTO equity_snapshots (connection_id, ts, equity, available, upnl) VALUES ('c1',?,'100','100','0')", t0)
	// Source opens 1 BTC at 100 (equity 1000), then halves it at 110.
	exec(`INSERT INTO signals (id, task_id, ts, base, kind, from_size, to_size, text, src_ts, src_px, src_entry, src_equity, src_realized, src_basis)
		VALUES (1,'t1',?, 'BTC','open','0','1','',?, '100', NULL, '1000', '0', 'fills')`, t0+2000, t0)
	exec(`INSERT INTO signals (id, task_id, ts, base, kind, from_size, to_size, text, src_ts, src_px, src_entry, src_equity, src_realized, src_basis)
		VALUES (2,'t1',?, 'BTC','reduce','1','0.5','',?, '110', '100', '1000', '5', 'fills')`, t0+62000, t0+60000)
	exec(`INSERT INTO orders (task_id, signal_id, connection_id, ts, base, buy, qty, status, fill_px, fill_qty, purpose) VALUES ('t1',1,'c1',?,'BTC',1,'0.1','filled','101','0.1','sync')`, t0+3000)
	exec(`INSERT INTO orders (task_id, signal_id, connection_id, ts, base, buy, qty, status, fill_px, fill_qty, purpose) VALUES ('t1',2,'c1',?,'BTC',0,'0.05','filled','109','0.05','sync')`, t0+63500)

	s := &Server{E: &engine.Engine{DB: db}}
	out, err := exportTaskAudit(ctx, s, []byte(`{"task_id":"t1","range":"all"}`))
	if err != nil {
		t.Fatal(err)
	}
	text := strings.TrimPrefix(out.(map[string]any)["csv"].(string), "\ufeff")
	recs, err := csv.NewReader(strings.NewReader(text)).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 3 {
		t.Fatalf("rows: %d\n%s", len(recs), text)
	}
	col := map[string]int{}
	for i, h := range recs[0] {
		col[h] = i
	}
	get := func(row int, name string) string {
		i, ok := col[name]
		if !ok {
			t.Fatalf("no column %q", name)
		}
		return recs[row][i]
	}
	want := []struct {
		row        int
		name, want string
	}{
		{1, "源动作", "开仓"},
		{1, "检测延迟(ms)", "2000"},
		{1, "时间偏差(ms)", "3000"},
		{1, "源仓位占权益%", "10.0000"},
		{1, "我方仓位占权益%", "10.1000"},
		{1, "占比偏差(pp)", "0.1000"},
		{1, "价格偏差%(正=我方不利)", "1.0000"},
		{1, "源数据口径", "源成交记录"},
		{2, "时间偏差(ms)", "3500"},
		{2, "源变动比例%", "-50.0000"},
		{2, "我方变动比例%", "-50.0000"},
		{2, "变动比例偏差(pp)", "0.0000"},
		{2, "价格偏差%(正=我方不利)", "0.9091"},
		{2, "源收益率%", "10.0000"},
		{2, "我方收益率%", "7.9208"},
		{2, "收益率偏差(pp)", "-2.0792"},
		{2, "源已实现盈亏", "5"},
		{2, "我方已实现盈亏", "0.4"},
		{2, "我方持仓均价(变动前)", "101"},
	}
	for _, w := range want {
		if got := get(w.row, w.name); got != w.want {
			t.Errorf("row %d %s = %q, want %q", w.row, w.name, got, w.want)
		}
	}
}
