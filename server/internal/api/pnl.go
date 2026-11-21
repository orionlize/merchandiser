package api

import (
	"context"
	"database/sql"
	"math"
	"sort"
	"strconv"

	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// pnlCurve buckets per range: about 100-200 points each.
var pnlSteps = map[string]int64{
	"today": 15 * 60_000,
	"7d":    3_600_000,
	"30d":   4 * 3_600_000,
	"all":   86_400_000,
}

const sparkDays = 14

type eqPoint struct {
	ts int64
	eq float64
}

// eqSeries is one account's equity history, oldest first.
type eqSeries []eqPoint

// at returns equity as of t: the last snapshot at or before t, or the first
// one after it when the account has no earlier history (it joined later).
func (s eqSeries) at(t int64) (float64, bool) {
	if len(s) == 0 {
		return 0, false
	}
	i := sort.Search(len(s), func(i int) bool { return s[i].ts > t })
	if i == 0 {
		return s[0].eq, true
	}
	return s[i-1].eq, true
}

type TaskPnl struct {
	TaskID      string  `json:"task_id"`
	Name        string  `json:"name"`
	Status      string  `json:"status"`
	PauseReason *string `json:"pause_reason"`
	// The task's own PnL over the range (realised + unrealised on its ledger shares).
	Pnl         float64 `json:"pnl"`
	StartEquity float64 `json:"start_equity"`
	// Daily PnL for the last 14 days, oldest first: [day start ms, pnl].
	Daily [][2]float64 `json:"daily"`
}

type PnlCurve struct {
	Range string `json:"range"`
	Since int64  `json:"since"`
	// [ts, pnl since the range start], summed over live follower accounts.
	Points      [][2]float64 `json:"points"`
	StartEquity float64      `json:"start_equity"`
	Tasks       []TaskPnl    `json:"tasks"`
}

// loadEquity reads one account's equity at the curve's points only: `since`,
// each `step` boundary after it and `now`, one index seek each, plus the first
// sample at or after `since` for accounts that joined later. Samples are taken
// every minute, so reading them all made pnl_curve take seconds.
func loadEquity(ctx context.Context, s *Server, conn string, since, step, now int64) (eqSeries, error) {
	rows, err := s.E.DB.QueryContext(ctx, `
		WITH RECURSIVE b(t) AS (
			SELECT ?2
			UNION ALL SELECT t - t % ?3 + ?3 FROM b WHERE t - t % ?3 + ?3 < ?4
		), pts(t) AS (SELECT t FROM b UNION SELECT ?4)
		SELECT t, (SELECT equity FROM equity_snapshots WHERE connection_id = ?1 AND ts <= pts.t ORDER BY ts DESC LIMIT 1) FROM pts
		UNION ALL
		SELECT * FROM (SELECT ts, equity FROM equity_snapshots WHERE connection_id = ?1 AND ts >= ?2 ORDER BY ts LIMIT 1)
		ORDER BY 1`, conn, since, step, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := eqSeries{}
	for rows.Next() {
		var p eqPoint
		var eq sql.NullString
		if err := rows.Scan(&p.ts, &eq); err != nil {
			return nil, err
		}
		if !eq.Valid {
			continue // before the account's first sample
		}
		if p.eq, err = strconv.ParseFloat(eq.String, 64); err != nil {
			continue
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func pnlCurve(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Range string `json:"range"`
	}](body)
	if err != nil {
		return nil, err
	}
	step, ok := pnlSteps[a.Range]
	if !ok {
		a.Range, step = "30d", pnlSteps["30d"]
	}
	db := s.E.DB
	now := util.NowMs()
	since := rangeStart(a.Range)
	today := util.StartOfTodayMs()
	sparkFrom := today - (sparkDays-1)*86_400_000

	followerIDs, err := strings_(ctx, s, "SELECT DISTINCT connection_id FROM task_followers")
	if err != nil {
		return nil, err
	}
	conns, err := store.Connections(ctx, db)
	if err != nil {
		return nil, err
	}
	platform := map[string]string{}
	for _, c := range conns {
		platform[c.ID] = c.Platform
	}
	if a.Range == "all" {
		// Start where the history starts.
		var first sql.NullInt64
		if err := db.QueryRowContext(ctx, "SELECT MIN(ts) FROM equity_snapshots WHERE connection_id IN (SELECT connection_id FROM task_followers)").Scan(&first); err != nil {
			return nil, err
		}
		since = now
		if first.Valid && first.Int64 < now {
			since = first.Int64
		}
	}
	series := map[string]eqSeries{}
	for _, id := range followerIDs {
		if series[id], err = loadEquity(ctx, s, id, since, step, now); err != nil {
			return nil, err
		}
	}

	// Portfolio curve: real (non-paper) follower accounts, like the overview totals.
	out := PnlCurve{Range: a.Range, Since: since, Points: [][2]float64{}, Tasks: []TaskPnl{}}
	sum := func(ids []string, t int64) (float64, bool) {
		v, any := 0.0, false
		for _, id := range ids {
			if e, ok := series[id].at(t); ok {
				v += e
				any = true
			}
		}
		return v, any
	}
	real := []string{}
	for _, id := range followerIDs {
		if platform[id] != "paper" {
			real = append(real, id)
		}
	}
	if base, ok := sum(real, since); ok {
		out.StartEquity = base
		start := since - since%step
		for t := start; t < now; t += step {
			if v, ok := sum(real, max(t, since)); ok {
				out.Points = append(out.Points, [2]float64{float64(max(t, since)), round2(v - base)})
			}
		}
		if v, ok := sum(real, now); ok {
			out.Points = append(out.Points, [2]float64{float64(now), round2(v - base)})
		}
	}

	trows, err := store.Tasks(ctx, db)
	if err != nil {
		return nil, err
	}
	for _, t := range trows {
		frows, err := store.Followers(ctx, db, t.ID)
		if err != nil {
			return nil, err
		}
		ids := make([]string, 0, len(frows))
		for _, f := range frows {
			ids = append(ids, f.ConnectionID)
		}
		from := since
		if t.StartedAt != nil && *t.StartedAt > from {
			from = *t.StartedAt
		}
		tp := TaskPnl{TaskID: t.ID, Name: t.Name, Status: t.Status, PauseReason: t.PauseReason, Daily: [][2]float64{}}
		if t.StoppedAt != nil && t.Status == "stopped" && *t.StoppedAt < from {
			out.Tasks = append(out.Tasks, tp)
			continue
		}
		end := now
		if t.Status == "stopped" && t.StoppedAt != nil {
			end = *t.StoppedAt
		}
		// `from` is not on a bucket boundary: look it up exactly.
		b, any := 0.0, false
		for _, id := range ids {
			// Zero means no sample at all (audit.go's equityAt).
			if e := equityAt(ctx, db, id, from); !e.IsZero() {
				v, _ := e.Float64()
				b += v
				any = true
			}
		}
		if any {
			tp.StartEquity = round2(b)
		}
		// The task's own PnL (ledger), not its accounts' equity change: tasks
		// sharing an account would otherwise all show the same number.
		// About 16 indexed lookups per task instead of reading every sample.
		cur, _ := s.E.TaskPnl(t.ID)
		nowPnl, _ := cur.Float64()
		var aerr error
		at := func(ts int64) float64 {
			if ts >= now {
				return nowPnl
			}
			v, err := store.TaskPnlAt(ctx, db, t.ID, ts)
			if err != nil {
				aerr = err
			}
			f, _ := v.Float64()
			return f
		}
		tp.Pnl = round2(at(end) - at(from))
		for d := sparkFrom; d <= today; d += 86_400_000 {
			lo, hi := max(d, from), min(d+86_400_000, end)
			v := 0.0
			if hi > lo {
				v = round2(at(hi) - at(lo))
			}
			tp.Daily = append(tp.Daily, [2]float64{float64(d), v})
		}
		if aerr != nil {
			return nil, aerr
		}
		out.Tasks = append(out.Tasks, tp)
	}
	sort.SliceStable(out.Tasks, func(i, j int) bool { return out.Tasks[i].Pnl > out.Tasks[j].Pnl })
	return out, nil
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
