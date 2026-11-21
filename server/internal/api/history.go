package api

import (
	"context"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// 历史仓位: closed round trips of a task's ledger shares.

type TripDto struct {
	store.TripRow
	Alias string `json:"alias"`
	// Largest notional held during the trip, at the trip's entry price.
	MaxNotional string  `json:"max_notional"`
	RoePct      *string `json:"roe_pct"`
	HoldMs      int64   `json:"hold_ms"`
	// Realised less fees plus funding.
	Net string `json:"net"`
}

type TripStats struct {
	Count        int     `json:"count"`
	Wins         int     `json:"wins"`
	Losses       int     `json:"losses"`
	WinRate      *string `json:"win_rate"`
	ProfitFactor *string `json:"profit_factor"`
	AvgWin       *string `json:"avg_win"`
	AvgLoss      *string `json:"avg_loss"`
	AvgHoldMs    *int64  `json:"avg_hold_ms"`
	Realized     string  `json:"realized"`
	Fees         string  `json:"fees"`
	Funding      string  `json:"funding"`
	Net          string  `json:"net"`
	// Close reasons: tp / sl / trail / sync / … → count.
	Reasons map[string]int `json:"reasons"`
}

type TripPage struct {
	Rows  []TripDto `json:"rows"`
	Total int       `json:"total"`
	Stats TripStats `json:"stats"`
}

func tripDto(t store.TripRow, aliases map[string]string) TripDto {
	d := TripDto{TripRow: t, Alias: aliases[t.ConnectionID], HoldMs: max(t.ClosedAt-t.OpenedAt, 0)}
	notional := util.Dec(t.MaxSize).Mul(util.Dec(t.EntryPx))
	d.MaxNotional = util.Fmt(notional.RoundBank(2))
	lev := util.One
	if t.Leverage != nil {
		if l := util.Dec(*t.Leverage); l.IsPositive() {
			lev = l
		}
	}
	net := tripNet(&t)
	d.Net = util.Fmt(net.RoundBank(6))
	if margin := notional.Div(lev); margin.IsPositive() {
		d.RoePct = util.Ptr(util.Fmt(net.Div(margin).Mul(util.Hundred).RoundBank(2)))
	}
	return d
}

func tripNet(t *store.TripRow) decimal.Decimal {
	return util.Dec(t.Realized).Sub(util.Dec(t.Fees)).Add(util.Dec(t.Funding))
}

func tripStats(rows []store.TripRow) TripStats {
	st := TripStats{Count: len(rows), Reasons: map[string]int{}, Realized: "0"}
	won, lost, total, gross, fees, funding := decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero
	var hold int64
	for i := range rows {
		t := &rows[i]
		r := tripNet(t)
		total = total.Add(r)
		gross = gross.Add(util.Dec(t.Realized))
		fees = fees.Add(util.Dec(t.Fees))
		funding = funding.Add(util.Dec(t.Funding))
		hold += max(t.ClosedAt-t.OpenedAt, 0)
		st.Reasons[t.Reason]++
		switch {
		case r.IsPositive():
			st.Wins++
			won = won.Add(r)
		case r.IsNegative():
			st.Losses++
			lost = lost.Add(r.Neg())
		}
	}
	st.Realized = util.Fmt(gross.RoundBank(2))
	st.Fees, st.Funding, st.Net = util.Fmt(fees.RoundBank(2)), util.Fmt(funding.RoundBank(2)), util.Fmt(total.RoundBank(2))
	if n := st.Wins + st.Losses; n > 0 {
		st.WinRate = util.Ptr(util.Fmt(decimal.NewFromInt(int64(st.Wins)).Div(decimal.NewFromInt(int64(n))).Mul(util.Hundred).RoundBank(1)))
	}
	if st.Wins > 0 {
		st.AvgWin = util.Ptr(util.Fmt(won.Div(decimal.NewFromInt(int64(st.Wins))).RoundBank(2)))
	}
	if st.Losses > 0 {
		st.AvgLoss = util.Ptr(util.Fmt(lost.Div(decimal.NewFromInt(int64(st.Losses))).Neg().RoundBank(2)))
		if lost.IsPositive() {
			st.ProfitFactor = util.Ptr(util.Fmt(won.Div(lost).RoundBank(2)))
		}
	}
	if st.Count > 0 {
		st.AvgHoldMs = util.Ptr(hold / int64(st.Count))
	}
	return st
}

func taskPositionHistory(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		ID           string  `json:"id"`
		ConnectionID *string `json:"connection_id"`
		Since        *int64  `json:"since"`
		Limit        *int    `json:"limit"`
		Offset       *int    `json:"offset"`
	}](body)
	if err != nil {
		return nil, err
	}
	q, args := "WHERE task_id = ?", []any{a.ID}
	if a.ConnectionID != nil && *a.ConnectionID != "" {
		q, args = q+" AND connection_id = ?", append(args, *a.ConnectionID)
	}
	if a.Since != nil {
		q, args = q+" AND closed_at >= ?", append(args, *a.Since)
	}
	all, err := store.Trips(ctx, s.E.DB, q+" ORDER BY closed_at DESC, id DESC", args...)
	if err != nil {
		return nil, err
	}
	conns, err := store.Connections(ctx, s.E.DB)
	if err != nil {
		return nil, err
	}
	aliases := map[string]string{}
	for _, c := range conns {
		aliases[c.ID] = c.Alias
	}
	limit, offset := 50, 0
	if a.Limit != nil {
		limit = min(max(*a.Limit, 0), 5000)
	}
	if a.Offset != nil {
		offset = max(*a.Offset, 0)
	}
	page := TripPage{Rows: []TripDto{}, Total: len(all), Stats: tripStats(all)}
	for i := offset; i < len(all) && i < offset+limit; i++ {
		page.Rows = append(page.Rows, tripDto(all[i], aliases))
	}
	return page, nil
}

// 费用明细: a task's fees and funding.

type CostDto struct {
	store.CostRow
	Alias string `json:"alias"`
}

type CostPage struct {
	Rows   []CostDto        `json:"rows"`
	Totals store.CostTotals `json:"totals"`
	// Rows matching the filter (the page may hold fewer).
	Count int64 `json:"count"`
	// Rows per kind, ignoring the kind and account filters.
	Kinds map[string]int64 `json:"kinds"`
}

func taskCosts(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		ID           string  `json:"id"`
		Kind         *string `json:"kind"`
		ConnectionID *string `json:"connection_id"`
		Since        *int64  `json:"since"`
		Limit        *int    `json:"limit"`
	}](body)
	if err != nil {
		return nil, err
	}
	since := int64(0)
	if a.Since != nil {
		since = *a.Since
	}
	q, args := "WHERE c.task_id = ? AND c.ts >= ?", []any{a.ID, since}
	if a.Kind != nil && (*a.Kind == "fee" || *a.Kind == "funding") {
		q, args = q+" AND c.kind = ?", append(args, *a.Kind)
	}
	if a.ConnectionID != nil && *a.ConnectionID != "" {
		q, args = q+" AND c.connection_id = ?", append(args, *a.ConnectionID)
	}
	limit := 200
	if a.Limit != nil {
		limit = min(max(*a.Limit, 1), 20000)
	}
	db := s.E.DB
	count, err := store.Count(ctx, db, "SELECT COUNT(*) FROM task_costs c "+q, args...)
	if err != nil {
		return nil, err
	}
	rows, err := store.Costs(ctx, db, q+" ORDER BY c.ts DESC, c.id DESC LIMIT ?", append(args, limit)...)
	if err != nil {
		return nil, err
	}
	totals, err := store.TaskCostTotals(ctx, db, a.ID, since)
	if err != nil {
		return nil, err
	}
	conns, err := store.Connections(ctx, db)
	if err != nil {
		return nil, err
	}
	aliases := map[string]string{}
	for _, c := range conns {
		aliases[c.ID] = c.Alias
	}
	page := CostPage{Rows: []CostDto{}, Totals: totals, Count: count, Kinds: map[string]int64{}}
	if err := func() error {
		rs, err := db.QueryContext(ctx, "SELECT kind, COUNT(*) FROM task_costs WHERE task_id = ? AND ts >= ? GROUP BY kind", a.ID, since)
		if err != nil {
			return err
		}
		defer rs.Close()
		for rs.Next() {
			var k string
			var n int64
			if err := rs.Scan(&k, &n); err != nil {
				return err
			}
			page.Kinds[k] = n
		}
		return rs.Err()
	}(); err != nil {
		return nil, err
	}
	for _, r := range rows {
		page.Rows = append(page.Rows, CostDto{CostRow: r, Alias: aliases[r.ConnectionID]})
	}
	return page, nil
}
