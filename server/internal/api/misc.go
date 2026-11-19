package api

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/engine"
	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/secrets"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// ===================== overview =====================

type AccountDto struct {
	ID       string  `json:"id"`
	Alias    string  `json:"alias"`
	Platform string  `json:"platform"`
	Testnet  bool    `json:"testnet"`
	Equity   *string `json:"equity"`
	TodayPnl *string `json:"today_pnl"`
}

// OverviewPosition is an open position on a follower account, with the
// tasks that copy that coin onto it.
type OverviewPosition struct {
	engine.PositionLive
	Platform string   `json:"platform"`
	Testnet  bool     `json:"testnet"`
	Tasks    []IDName `json:"tasks"`
}

type IDName struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type TodayStats struct {
	Signals        int64   `json:"signals"`
	Orders         int64   `json:"orders"`
	AvgSlippagePct *string `json:"avg_slippage_pct"`
	Skipped        int64   `json:"skipped"`
	Failed         int64   `json:"failed"`
}

type OverviewDto struct {
	TotalEquity   string             `json:"total_equity"`
	FollowerCount int                `json:"follower_count"`
	TodayPnl      string             `json:"today_pnl"`
	TodayPnlPct   string             `json:"today_pnl_pct"`
	Upnl          string             `json:"upnl"`
	Available     string             `json:"available"`
	Notional      string             `json:"notional"`
	LatencyP95    *int64             `json:"latency_p95"`
	Accounts      []AccountDto       `json:"accounts"`
	Positions     []OverviewPosition `json:"positions"`
	Tasks         []*TaskSummary     `json:"tasks"`
	Alerts        []store.AlertRow   `json:"alerts"`
	Today         TodayStats         `json:"today"`
	Estopped      bool               `json:"estopped"`
}

func strings_(ctx context.Context, s *Server, q string, args ...any) ([]string, error) {
	rows, err := s.E.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func getOverview(ctx context.Context, s *Server, _ []byte) (any, error) {
	db := s.E.DB
	day := util.StartOfTodayMs()
	// Accounts that are followers in any task, plus every paper / trade-capable account.
	ids, err := strings_(ctx, s, "SELECT DISTINCT connection_id FROM task_followers")
	if err != nil {
		return nil, err
	}
	followerIDs := map[string]bool{}
	for _, id := range ids {
		followerIDs[id] = true
	}
	eq, start, upnl, avail, notional := decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero
	accounts := []AccountDto{}
	conns, err := store.Connections(ctx, db)
	if err != nil {
		return nil, err
	}
	for _, c := range conns {
		latest, first, err := store.EquityBounds(ctx, db, c.ID, day)
		if err != nil {
			return nil, err
		}
		isFollower := followerIDs[c.ID]
		var today *string
		if latest != nil && first != nil {
			today = util.Ptr(util.Fmt(util.Dec(latest.Equity).Sub(util.Dec(*first)).RoundBank(2)))
		}
		if isFollower && c.Platform != "paper" && latest != nil {
			eq = eq.Add(util.Dec(latest.Equity))
			avail = avail.Add(util.Dec(latest.Available))
			upnl = upnl.Add(util.Dec(latest.Upnl))
			notional = notional.Add(util.Dec(latest.Notional))
			if first != nil {
				start = start.Add(util.Dec(*first))
			} else {
				start = start.Add(util.Dec(latest.Equity))
			}
		}
		perms := parsePerms(c.PermsJSON)
		if isFollower || (perms != nil && perms.Trade) {
			a := AccountDto{ID: c.ID, Alias: c.Alias, Platform: c.Platform, Testnet: c.Testnet, TodayPnl: today}
			if latest != nil {
				a.Equity = &latest.Equity
			}
			accounts = append(accounts, a)
		}
	}
	followerCount := 0
	for _, a := range accounts {
		if a.Platform != "paper" && followerIDs[a.ID] {
			followerCount++
		}
	}
	trows, err := store.Tasks(ctx, db)
	if err != nil {
		return nil, err
	}
	tasks := []*TaskSummary{}
	for i := range trows {
		if trows[i].Status == "stopped" {
			continue
		}
		sum, err := summarize(ctx, s, &trows[i])
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, sum)
	}
	// Positions on every listed account, tagged with the tasks managing each coin.
	owners := map[string][]IDName{}
	for _, t := range tasks {
		if t.Live == nil {
			continue
		}
		for _, p := range t.Live.Positions {
			k := p.ConnectionID + "|" + p.Base
			owners[k] = append(owners[k], IDName{ID: t.ID, Name: t.Name})
		}
	}
	positions := []OverviewPosition{}
	for _, a := range accounts {
		for _, p := range engine.PositionsOf(a.ID, a.Alias, s.E.LatestSnapshot(a.ID)) {
			op := OverviewPosition{PositionLive: p, Platform: a.Platform, Testnet: a.Testnet, Tasks: owners[a.ID+"|"+p.Base]}
			if op.Tasks == nil {
				op.Tasks = []IDName{}
			}
			positions = append(positions, op)
		}
	}
	sort.SliceStable(positions, func(i, j int) bool {
		return util.Dec(positions[i].Notional).GreaterThan(util.Dec(positions[j].Notional))
	})
	alerts, err := store.Alerts(ctx, db, 6)
	if err != nil {
		return nil, err
	}
	if alerts == nil {
		alerts = []store.AlertRow{}
	}
	var st TodayStats
	counts := []struct {
		dst *int64
		q   string
	}{
		{&st.Signals, "SELECT COUNT(*) FROM signals WHERE ts >= ? AND kind NOT IN ('risk','reconcile')"},
		{&st.Orders, "SELECT COUNT(*) FROM orders WHERE ts >= ? AND status NOT IN ('skipped')"},
		{&st.Skipped, "SELECT COUNT(*) FROM orders WHERE ts >= ? AND status = 'skipped'"},
		{&st.Failed, "SELECT COUNT(*) FROM orders WHERE ts >= ? AND status = 'failed'"},
	}
	for _, c := range counts {
		if *c.dst, err = store.Count(ctx, db, c.q, day); err != nil {
			return nil, err
		}
	}
	slips, err := strings_(ctx, s, "SELECT slippage_bps FROM orders WHERE ts >= ? AND slippage_bps IS NOT NULL", day)
	if err != nil {
		return nil, err
	}
	if len(slips) > 0 {
		sum := decimal.Zero
		for _, x := range slips {
			sum = sum.Add(util.Dec(x))
		}
		st.AvgSlippagePct = util.Ptr(util.Fmt(sum.Div(util.D(int64(len(slips)))).Div(util.Hundred).RoundBank(3)))
	}
	lats, err := int64s(ctx, s, "SELECT latency_ms FROM orders WHERE ts >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms", day)
	if err != nil {
		return nil, err
	}
	todayPnl := eq.Sub(start)
	pct := "0"
	if !start.IsZero() {
		pct = util.Fmt(todayPnl.Div(start).Mul(util.Hundred).RoundBank(2))
	}
	return OverviewDto{
		TotalEquity: util.Fmt(eq.RoundBank(2)), FollowerCount: followerCount, TodayPnl: util.Fmt(todayPnl.RoundBank(2)), TodayPnlPct: pct,
		Upnl: util.Fmt(upnl.RoundBank(2)), Available: util.Fmt(avail.RoundBank(2)), Notional: util.Fmt(notional.RoundBank(2)),
		LatencyP95: p95(lats), Accounts: accounts, Positions: positions, Tasks: tasks, Alerts: alerts, Today: st, Estopped: s.E.Estopped(),
	}, nil
}

func listAlerts(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Limit *int64 `json:"limit"`
	}](body)
	if err != nil {
		return nil, err
	}
	limit := int64(50)
	if a.Limit != nil {
		limit = *a.Limit
	}
	out, err := store.Alerts(ctx, s.E.DB, limit)
	if out == nil && err == nil {
		out = []store.AlertRow{}
	}
	return out, err
}

// ===================== records =====================

type LogFilter struct {
	Range        string  `json:"range"`
	TaskID       *string `json:"task_id"`
	ConnectionID *string `json:"connection_id"`
	Status       *string `json:"status"`
	FillsOnly    *bool   `json:"fills_only"`
	Limit        *int64  `json:"limit"`
	Offset       *int64  `json:"offset"`
}

type LogRow struct {
	ID           int64   `json:"id"`
	Ts           int64   `json:"ts"`
	TaskID       string  `json:"task_id"`
	TaskName     *string `json:"task_name"`
	SignalText   *string `json:"signal_text"`
	ConnectionID *string `json:"connection_id"`
	Alias        *string `json:"alias"`
	Base         string  `json:"base"`
	Symbol       *string `json:"symbol"`
	Buy          *bool   `json:"buy"`
	Qty          *string `json:"qty"`
	OrderType    *string `json:"order_type"`
	Price        *string `json:"price"`
	ReduceOnly   bool    `json:"reduce_only"`
	Status       string  `json:"status"`
	FillPx       *string `json:"fill_px"`
	FillQty      *string `json:"fill_qty"`
	SlippageBps  *string `json:"slippage_bps"`
	LatencyMs    *int64  `json:"latency_ms"`
	Reason       *string `json:"reason"`
	Purpose      string  `json:"purpose"`
}

type LogPage struct {
	Rows    []LogRow `json:"rows"`
	Total   int64    `json:"total"`
	Skipped int64    `json:"skipped"`
	Failed  int64    `json:"failed"`
}

func rangeStart(r string) int64 {
	switch r {
	case "today":
		return util.StartOfTodayMs()
	case "7d":
		return util.NowMs() - 7*86_400_000
	case "30d":
		return util.NowMs() - 30*86_400_000
	}
	return 0
}

func queryLogsInner(ctx context.Context, s *Server, f *LogFilter, limit int64) (*LogPage, error) {
	db := s.E.DB
	since := rangeStart(f.Range)
	where := "o.ts >= ?"
	args := []any{since}
	if f.TaskID != nil {
		where += " AND o.task_id = ?"
		args = append(args, *f.TaskID)
	}
	if f.ConnectionID != nil {
		where += " AND o.connection_id = ?"
		args = append(args, *f.ConnectionID)
	}
	if f.FillsOnly != nil && *f.FillsOnly {
		where += " AND o.status IN ('filled','partial')"
	}
	baseWhere := where
	if f.Status != nil {
		switch *f.Status {
		case "skipped":
			where += " AND o.status = 'skipped'"
		case "failed":
			where += " AND o.status = 'failed'"
		}
	}
	offset := int64(0)
	if f.Offset != nil {
		offset = *f.Offset
	}
	q := `SELECT o.id, o.ts, o.task_id, t.name AS task_name, s.text AS signal_text, o.connection_id, c.alias, o.base, o.symbol, o.buy, o.qty, o.order_type, o.price, o.reduce_only, o.status, o.fill_px, o.fill_qty, o.slippage_bps, o.latency_ms, o.reason, o.purpose
		FROM orders o LEFT JOIN tasks t ON t.id = o.task_id LEFT JOIN signals s ON s.id = o.signal_id LEFT JOIN connections c ON c.id = o.connection_id
		WHERE ` + where + ` ORDER BY o.ts DESC, o.id DESC LIMIT ? OFFSET ?`
	rows, err := db.QueryContext(ctx, q, append(append([]any{}, args...), limit, offset)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := &LogPage{Rows: []LogRow{}}
	for rows.Next() {
		var r LogRow
		if err := rows.Scan(&r.ID, &r.Ts, &r.TaskID, &r.TaskName, &r.SignalText, &r.ConnectionID, &r.Alias, &r.Base, &r.Symbol, &r.Buy, &r.Qty, &r.OrderType, &r.Price, &r.ReduceOnly, &r.Status, &r.FillPx, &r.FillQty, &r.SlippageBps, &r.LatencyMs, &r.Reason, &r.Purpose); err != nil {
			return nil, err
		}
		page.Rows = append(page.Rows, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range []struct {
		dst   *int64
		extra string
	}{{&page.Total, ""}, {&page.Skipped, " AND o.status = 'skipped'"}, {&page.Failed, " AND o.status = 'failed'"}} {
		if *c.dst, err = store.Count(ctx, db, "SELECT COUNT(*) FROM orders o WHERE "+baseWhere+c.extra, args...); err != nil {
			return nil, err
		}
	}
	return page, nil
}

func queryLogs(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Filter LogFilter `json:"filter"`
	}](body)
	if err != nil {
		return nil, err
	}
	limit := int64(50)
	if a.Filter.Limit != nil {
		limit = min(*a.Filter.Limit, 500)
	}
	return queryLogsInner(ctx, s, &a.Filter, limit)
}

// exportLogsCsv returns the CSV text; the desktop client writes the file.
func exportLogsCsv(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Filter LogFilter `json:"filter"`
	}](body)
	if err != nil {
		return nil, err
	}
	page, err := queryLogsInner(ctx, s, &a.Filter, 1_000_000)
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	b.WriteString("\ufeff时间,任务,信号,跟单账户,品种,方向,数量,类型,价格,只减仓,状态,成交价,成交量,滑点(bp),耗时(ms),用途,原因\n")
	esc := func(p *string) string {
		v := ""
		if p != nil {
			v = *p
		}
		return `"` + strings.ReplaceAll(v, `"`, `""`) + `"`
	}
	or := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	for _, r := range page.Rows {
		dir := ""
		if r.Buy != nil {
			dir = "卖"
			if *r.Buy {
				dir = "买"
			}
		}
		ro := ""
		if r.ReduceOnly {
			ro = "是"
		}
		lat := ""
		if r.LatencyMs != nil {
			lat = strconv.FormatInt(*r.LatencyMs, 10)
		}
		b.WriteString(strings.Join([]string{
			time.UnixMilli(r.Ts).Local().Format("2006-01-02 15:04:05.000"),
			esc(r.TaskName), esc(r.SignalText), esc(r.Alias), r.Base, dir, or(r.Qty), or(r.OrderType), or(r.Price), ro,
			r.Status, or(r.FillPx), or(r.FillQty), or(r.SlippageBps), lat, r.Purpose, esc(r.Reason),
		}, ","))
		b.WriteByte('\n')
	}
	return map[string]any{"csv": b.String(), "rows": len(page.Rows)}, nil
}

type PnlRow struct {
	ConnectionID string  `json:"connection_id"`
	Alias        string  `json:"alias"`
	Platform     string  `json:"platform"`
	StartEquity  *string `json:"start_equity"`
	EndEquity    *string `json:"end_equity"`
	Pnl          *string `json:"pnl"`
	Fills        int64   `json:"fills"`
	Volume       string  `json:"volume"`
}

func pnlReport(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Range string `json:"range"`
	}](body)
	if err != nil {
		return nil, err
	}
	db := s.E.DB
	since := rangeStart(a.Range)
	conns, err := store.Connections(ctx, db)
	if err != nil {
		return nil, err
	}
	out := []PnlRow{}
	for _, c := range conns {
		latest, first, err := store.EquityBounds(ctx, db, c.ID, since)
		if err != nil {
			return nil, err
		}
		rows, err := db.QueryContext(ctx, "SELECT fill_qty, fill_px FROM orders WHERE connection_id = ? AND ts >= ? AND status IN ('filled','partial')", c.ID, since)
		if err != nil {
			return nil, err
		}
		vol := decimal.Zero
		var n int64
		for rows.Next() {
			var q, p *string
			if err := rows.Scan(&q, &p); err != nil {
				rows.Close()
				return nil, err
			}
			vol = vol.Add(util.DecP(q).Mul(util.DecP(p)))
			n++
		}
		rows.Close()
		r := PnlRow{ConnectionID: c.ID, Alias: c.Alias, Platform: c.Platform, StartEquity: first, Fills: n, Volume: util.Fmt(vol.RoundBank(2))}
		if latest != nil {
			r.EndEquity = &latest.Equity
			if first != nil {
				r.Pnl = util.Ptr(util.Fmt(util.Dec(latest.Equity).Sub(util.Dec(*first)).RoundBank(2)))
			}
		}
		out = append(out, r)
	}
	return out, nil
}

func equitySeries(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		ConnectionID *string `json:"connection_id"`
		SourceID     *string `json:"source_id"`
		Since        *int64  `json:"since"`
	}](body)
	if err != nil {
		return nil, err
	}
	since := util.NowMs() - 30*86_400_000
	if a.Since != nil {
		since = *a.Since
	}
	var q string
	var key string
	switch {
	case a.ConnectionID != nil:
		q, key = "SELECT ts, equity FROM equity_snapshots WHERE connection_id = ? AND ts >= ? ORDER BY ts", *a.ConnectionID
	case a.SourceID != nil:
		q, key = "SELECT ts, equity FROM source_equity WHERE source_id = ? AND ts >= ? ORDER BY ts", *a.SourceID
	default:
		return []any{}, nil
	}
	rows, err := s.E.DB.QueryContext(ctx, q, key, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := [][2]any{}
	for rows.Next() {
		var ts int64
		var eq string
		if err := rows.Scan(&ts, &eq); err != nil {
			return nil, err
		}
		out = append(out, [2]any{ts, eq})
	}
	return out, rows.Err()
}

// ===================== settings / lock =====================

func getSettings(context.Context, *Server, []byte) (any, error) {
	return store.SettingsCache(), nil
}

func setSettings(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Settings store.Settings `json:"settings"`
	}](body)
	if err != nil {
		return nil, err
	}
	st := a.Settings
	// App lock can only be turned on through set_lock_password.
	if cur := store.SettingsCache(); st.AppLock && !cur.AppLock {
		st.AppLock = false
	}
	if err := store.SaveSettings(ctx, s.E.DB, st); err != nil {
		return nil, err
	}
	s.E.Changed("settings")
	return st, nil
}

func setLockPassword(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Password *string `json:"password"`
	}](body)
	if err != nil {
		return nil, err
	}
	st := store.SettingsCache()
	if a.Password != nil && *a.Password != "" {
		if len([]rune(*a.Password)) < 4 {
			return nil, errs.Msg("密码至少 4 位")
		}
		h, err := secrets.HashPassword(*a.Password)
		if err != nil {
			return nil, err
		}
		if err := store.SetSetting(ctx, s.E.DB, "lock_hash", h); err != nil {
			return nil, err
		}
		st.AppLock = true
	} else {
		if err := store.DeleteSetting(ctx, s.E.DB, "lock_hash"); err != nil {
			return nil, err
		}
		st.AppLock = false
	}
	if err := store.SaveSettings(ctx, s.E.DB, st); err != nil {
		return nil, err
	}
	s.E.Changed("settings")
	return nil, nil
}

func lockAppH(ctx context.Context, s *Server, _ []byte) (any, error) {
	if !store.SettingsCache().AppLock {
		return false, nil
	}
	s.E.SetLocked(true)
	s.E.Changed("lock")
	return true, nil
}

func unlockApp(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Password string `json:"password"`
	}](body)
	if err != nil {
		return nil, err
	}
	h, err := store.GetSetting(ctx, s.E.DB, "lock_hash")
	if err != nil {
		return nil, err
	}
	if h != nil && *h != "" && !secrets.VerifyPassword(a.Password, *h) {
		// Slow brute force down a little.
		time.Sleep(500 * time.Millisecond)
		return nil, errs.Msg("密码错误")
	}
	s.E.SetLocked(false)
	s.E.Changed("lock")
	return nil, nil
}

func unlockSecrets(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Password string `json:"password"`
	}](body)
	if err != nil {
		return nil, err
	}
	wasLocked := s.E.Secrets.Locked()
	if err := s.E.Secrets.Unlock(a.Password); err != nil {
		time.Sleep(500 * time.Millisecond)
		return nil, err
	}
	if wasLocked {
		go func() {
			s.E.RestoreOnBoot(s.Ctx)
			s.E.SampleEquity(s.Ctx)
		}()
	}
	s.E.Changed("secrets")
	return nil, nil
}

// ===================== symbol map =====================

type SymbolCell struct {
	Symbol      *string `json:"symbol"`
	CoinPerUnit *string `json:"coin_per_unit"`
	PxUnit      *string `json:"px_unit"`
	Manual      bool    `json:"manual"`
}

type SymbolMapRow struct {
	Base   string                `json:"base"`
	Cells  map[string]SymbolCell `json:"cells"`
	Manual bool                  `json:"manual"`
}

func symbolMap(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Query *string `json:"query"`
	}](body)
	if err != nil {
		return nil, err
	}
	all := s.E.AllMarkets(ctx)
	rows, err := s.E.DB.QueryContext(ctx, "SELECT base, platform FROM symbol_map")
	if err != nil {
		return nil, err
	}
	manual := map[string]bool{}
	for rows.Next() {
		var b, p string
		if err := rows.Scan(&b, &p); err != nil {
			rows.Close()
			return nil, err
		}
		manual[b+"|"+p] = true
	}
	rows.Close()
	set := map[string]bool{}
	for _, m := range all {
		for b := range m.ByBase {
			set[b] = true
		}
	}
	bases := make([]string, 0, len(set))
	for b := range set {
		bases = append(bases, b)
	}
	// Common coins first, then alphabetical.
	top := map[string]int{"BTC": 0, "ETH": 1, "SOL": 2, "XRP": 3, "DOGE": 4, "HYPE": 5, "BNB": 6, "PEPE": 7, "SUI": 8, "LINK": 9}
	rank := func(b string) int {
		if r, ok := top[b]; ok {
			return r
		}
		return 1 << 30
	}
	sort.Slice(bases, func(i, j int) bool {
		ri, rj := rank(bases[i]), rank(bases[j])
		if ri != rj {
			return ri < rj
		}
		return bases[i] < bases[j]
	})
	if a.Query != nil && strings.TrimSpace(*a.Query) != "" {
		q := strings.ToUpper(strings.TrimSpace(*a.Query))
		kept := bases[:0]
		for _, b := range bases {
			if strings.Contains(b, q) {
				kept = append(kept, b)
			}
		}
		bases = kept
	}
	if len(bases) > 300 {
		bases = bases[:300]
	}
	out := []SymbolMapRow{}
	for _, b := range bases {
		row := SymbolMapRow{Base: b, Cells: map[string]SymbolCell{}}
		for _, p := range model.LivePlatforms {
			isManual := manual[b+"|"+string(p)]
			row.Manual = row.Manual || isManual
			cell := SymbolCell{Manual: isManual}
			if m := all[p]; m != nil {
				if spec := m.Base(b); spec != nil {
					cell.Symbol = &spec.Symbol
					cell.CoinPerUnit = util.Ptr(util.Fmt(spec.CoinPerUnit))
					cell.PxUnit = util.Ptr(util.Fmt(spec.PxUnit))
				}
			}
			row.Cells[string(p)] = cell
		}
		out = append(out, row)
	}
	return out, nil
}

func setSymbolOverride(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Base     string  `json:"base"`
		Platform string  `json:"platform"`
		Symbol   *string `json:"symbol"`
		Disabled bool    `json:"disabled"`
		Clear    *bool   `json:"clear"`
	}](body)
	if err != nil {
		return nil, err
	}
	db := s.E.DB
	if a.Clear != nil && *a.Clear {
		_, err = db.ExecContext(ctx, "DELETE FROM symbol_map WHERE base = ? AND platform = ?", a.Base, a.Platform)
	} else {
		var sym *string
		if a.Symbol != nil && strings.TrimSpace(*a.Symbol) != "" {
			sym = a.Symbol
		}
		_, err = db.ExecContext(ctx, "INSERT INTO symbol_map (base, platform, symbol, disabled) VALUES (?,?,?,?) ON CONFLICT(base, platform) DO UPDATE SET symbol = excluded.symbol, disabled = excluded.disabled",
			strings.ToUpper(strings.TrimSpace(a.Base)), a.Platform, sym, a.Disabled)
	}
	if err != nil {
		return nil, err
	}
	s.E.InvalidateMarkets()
	s.E.Changed("symbols")
	return nil, nil
}

func regenerateSymbolMap(ctx context.Context, s *Server, _ []byte) (any, error) {
	s.E.InvalidateMarkets()
	s.E.AllMarkets(ctx)
	if err := store.SetSetting(ctx, s.E.DB, "symbols_updated", strconv.FormatInt(util.NowMs(), 10)); err != nil {
		return nil, err
	}
	s.E.Changed("symbols")
	return nil, nil
}

func symbolsUpdatedAt(ctx context.Context, s *Server, _ []byte) (any, error) {
	v, err := store.GetSetting(ctx, s.E.DB, "symbols_updated")
	if err != nil || v == nil {
		return nil, err
	}
	n, err := strconv.ParseInt(*v, 10, 64)
	if err != nil {
		return nil, nil
	}
	return n, nil
}

// ===================== config import / export (no secrets) =====================

// symbolOverride serialises as the [base, platform, symbol, disabled] tuple
// the desktop build wrote.
type symbolOverride struct {
	Base, Platform string
	Symbol         *string
	Disabled       bool
}

func (o symbolOverride) MarshalJSON() ([]byte, error) {
	return json.Marshal([]any{o.Base, o.Platform, o.Symbol, o.Disabled})
}

func (o *symbolOverride) UnmarshalJSON(b []byte) error {
	var a []json.RawMessage
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	if len(a) != 4 {
		return fmt.Errorf("symbol_map 项格式错误")
	}
	if err := json.Unmarshal(a[0], &o.Base); err != nil {
		return err
	}
	if err := json.Unmarshal(a[1], &o.Platform); err != nil {
		return err
	}
	if err := json.Unmarshal(a[2], &o.Symbol); err != nil {
		return err
	}
	return json.Unmarshal(a[3], &o.Disabled)
}

type ConfigExport struct {
	Version     uint32              `json:"version"`
	Connections []map[string]any    `json:"connections"`
	Sources     []store.SourceRow   `json:"sources"`
	Tasks       []store.TaskRow     `json:"tasks"`
	Followers   []store.FollowerRow `json:"followers"`
	SymbolMap   []symbolOverride    `json:"symbol_map"`
	Settings    store.Settings      `json:"settings"`
}

// exportConfig returns the config object; the desktop client writes the file.
func exportConfig(ctx context.Context, s *Server, _ []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	db := s.E.DB
	conns, err := store.Connections(ctx, db)
	if err != nil {
		return nil, err
	}
	cfg := ConfigExport{Version: 1, Connections: []map[string]any{}, Followers: []store.FollowerRow{}, SymbolMap: []symbolOverride{}, Settings: store.SettingsCache()}
	for _, c := range conns {
		cfg.Connections = append(cfg.Connections, map[string]any{"id": c.ID, "platform": c.Platform, "alias": c.Alias, "testnet": c.Testnet, "proxy": c.Proxy, "paper_initial": c.PaperInitial})
	}
	if cfg.Sources, err = store.Sources(ctx, db); err != nil {
		return nil, err
	}
	tasks, err := store.Tasks(ctx, db)
	if err != nil {
		return nil, err
	}
	for _, t := range tasks {
		fs, err := store.Followers(ctx, db, t.ID)
		if err != nil {
			return nil, err
		}
		for _, f := range fs {
			f.StartEquity = nil
			cfg.Followers = append(cfg.Followers, f)
		}
		t.BaselineJSON = nil
		cfg.Tasks = append(cfg.Tasks, t)
	}
	rows, err := db.QueryContext(ctx, "SELECT base, platform, symbol, disabled FROM symbol_map")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var o symbolOverride
		if err := rows.Scan(&o.Base, &o.Platform, &o.Symbol, &o.Disabled); err != nil {
			return nil, err
		}
		cfg.SymbolMap = append(cfg.SymbolMap, o)
	}
	if cfg.Sources == nil {
		cfg.Sources = []store.SourceRow{}
	}
	if cfg.Tasks == nil {
		cfg.Tasks = []store.TaskRow{}
	}
	return cfg, rows.Err()
}

func importConfig(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Config ConfigExport `json:"config"`
	}](body)
	if err != nil {
		return nil, err
	}
	cfg := a.Config
	tx, err := s.E.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	str := func(m map[string]any, k string) any {
		if v, ok := m[k].(string); ok {
			return v
		}
		return nil
	}
	var nConn int64
	for _, c := range cfg.Connections {
		testnet, _ := c["testnet"].(bool)
		r, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO connections (id, platform, alias, testnet, key_hint, proxy, paper_initial, created_at) VALUES (?,?,?,?,'',?,?,?)",
			str(c, "id"), str(c, "platform"), str(c, "alias"), testnet, str(c, "proxy"), str(c, "paper_initial"), util.NowMs())
		if err != nil {
			return nil, err
		}
		n, _ := r.RowsAffected()
		nConn += n
	}
	for _, src := range cfg.Sources {
		// Fill-reconstruction state is not exported: an imported 'fills'
		// source starts from the import time, never from the old anchor.
		created := src.CreatedAt
		if src.IsFills() {
			created = util.NowMs()
		}
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO sources (id, kind, name, platform, connection_id, address, testnet, created_at, lead_mode, lead_poll) VALUES (?,?,?,?,?,?,?,?,?,?)",
			src.ID, src.Kind, src.Name, src.Platform, src.ConnectionID, src.Address, src.Testnet, created, src.LeadMode, src.LeadPoll); err != nil {
			return nil, err
		}
	}
	for _, t := range cfg.Tasks {
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO tasks (id, name, source_id, status, rules_json, risk_json, pause_reason, created_at) VALUES (?,?,?,'stopped',?,?,?,?)",
			t.ID, t.Name, t.SourceID, t.RulesJSON, t.RiskJSON, "导入的任务", t.CreatedAt); err != nil {
			return nil, err
		}
	}
	for _, f := range cfg.Followers {
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO task_followers (task_id, connection_id, override_json) VALUES (?,?,?)", f.TaskID, f.ConnectionID, f.OverrideJSON); err != nil {
			return nil, err
		}
	}
	for _, o := range cfg.SymbolMap {
		if _, err := tx.ExecContext(ctx, "INSERT OR REPLACE INTO symbol_map (base, platform, symbol, disabled) VALUES (?,?,?,?)", o.Base, o.Platform, o.Symbol, o.Disabled); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	s.E.InvalidateMarkets()
	s.E.Changed("all")
	return fmt.Sprintf("已导入 %d 个连接（需重新填写密钥）、%d 个信号源、%d 个任务（均为已停止状态）", nConn, len(cfg.Sources), len(cfg.Tasks)), nil
}

// ===================== registry =====================

var handlers map[string]handler

func init() {
	handlers = map[string]handler{
		"get_health":          getHealth,
		"emergency_stop":      emergencyStop,
		"release_estop":       releaseEstop,
		"close_all_positions": closeAllPositions,

		"validate_connection": validateConnection,
		"save_connection":     saveConnection,
		"list_connections":    listConnections,
		"test_connection":     testConnection,
		"switch_one_way":      switchOneWay,
		"delete_connection":   deleteConnection,

		"list_sources":         listSources,
		"add_source":           addSource,
		"probe_lead_trader":    probeLeadTrader,
		"search_lead_traders":  searchLeadTraders,
		"delete_source":        deleteSource,
		"backfill_source":      backfillSource,
		"set_source_lead_poll": setSourceLeadPoll,
		"source_detail":        sourceDetail,
		"paper_trade":          paperTrade,

		"list_tasks":   listTasks,
		"get_task":     getTask,
		"create_task":  createTask,
		"update_task":  updateTask,
		"task_action":  taskAction,
		"delete_task":  deleteTask,
		"preview_task": previewTask,

		"get_overview":    getOverview,
		"list_alerts":     listAlerts,
		"query_logs":      queryLogs,
		"export_logs_csv": exportLogsCsv,
		"pnl_report":      pnlReport,
		"equity_series":   equitySeries,
		"task_chart":      taskChart,
		"pnl_curve":       pnlCurve,

		"get_settings":      getSettings,
		"set_settings":      setSettings,
		"set_lock_password": setLockPassword,
		"lock_app":          lockAppH,
		"unlock_app":        unlockApp,
		"unlock_secrets":    unlockSecrets,

		"symbol_map":            symbolMap,
		"set_symbol_override":   setSymbolOverride,
		"regenerate_symbol_map": regenerateSymbolMap,
		"symbols_updated_at":    symbolsUpdatedAt,
		"export_config":         exportConfig,
		"import_config":         importConfig,
	}
}
