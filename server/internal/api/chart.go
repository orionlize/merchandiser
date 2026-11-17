package api

import (
	"context"
	"slices"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/exchange"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// chartBars is how many candles a task chart shows.
const chartBars = 300

var chartIntervals = map[string]int64{
	"15m": 15 * 60_000,
	"1h":  3_600_000,
	"4h":  4 * 3_600_000,
	"1d":  86_400_000,
}

// ChartFill is one copied fill, drawn as a marker on the task chart.
type ChartFill struct {
	ID           int64   `json:"id"`
	SignalID     *int64  `json:"signal_id"`
	Ts           int64   `json:"ts"`
	ConnectionID *string `json:"connection_id"`
	Buy          bool    `json:"buy"`
	Qty          string  `json:"qty"`
	Px           string  `json:"px"`
	RefPx        *string `json:"ref_px"`
	SlippageBps  *string `json:"slippage_bps"`
	LatencyMs    *int64  `json:"latency_ms"`
	ReduceOnly   bool    `json:"reduce_only"`
	Purpose      string  `json:"purpose"`
}

type TaskChart struct {
	Base     string `json:"base"`
	Interval string `json:"interval"`
	// Bases the task has filled, most recent first.
	Bases   []string          `json:"bases"`
	Candles []exchange.Candle `json:"candles"`
	// Set when candles could not be loaded; fills are still returned.
	CandleError *string `json:"candle_error"`
	// Every fill of this base (oldest first, up to 2000), so the client can
	// replay average price and size from the start of the position.
	Fills []ChartFill `json:"fills"`
}

func taskChart(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		TaskID       string  `json:"task_id"`
		Base         string  `json:"base"`
		Interval     string  `json:"interval"`
		ConnectionID *string `json:"connection_id"`
	}](body)
	if err != nil {
		return nil, err
	}
	step, ok := chartIntervals[a.Interval]
	if !ok {
		a.Interval, step = "4h", chartIntervals["4h"]
	}
	db := s.E.DB

	bases := []string{}
	rows, err := db.QueryContext(ctx, "SELECT base FROM orders WHERE task_id = ? AND fill_qty IS NOT NULL AND fill_px IS NOT NULL GROUP BY base ORDER BY MAX(ts) DESC", a.TaskID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var b string
		if err := rows.Scan(&b); err != nil {
			rows.Close()
			return nil, err
		}
		bases = append(bases, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	base := a.Base
	if base == "" {
		if len(bases) == 0 {
			return TaskChart{Interval: a.Interval, Bases: bases, Candles: []exchange.Candle{}, Fills: []ChartFill{}}, nil
		}
		base = bases[0]
	}

	q := "WHERE task_id = ? AND base = ? AND fill_qty IS NOT NULL AND fill_px IS NOT NULL"
	args := []any{a.TaskID, base}
	if a.ConnectionID != nil {
		q += " AND connection_id = ?"
		args = append(args, *a.ConnectionID)
	}
	orders, err := store.Orders(ctx, db, q+" ORDER BY ts DESC, id DESC LIMIT 2000", args...)
	if err != nil {
		return nil, err
	}
	slices.Reverse(orders)
	fills := make([]ChartFill, 0, len(orders))
	for _, o := range orders {
		if o.Buy == nil {
			continue
		}
		fills = append(fills, ChartFill{
			ID: o.ID, SignalID: o.SignalID, Ts: o.Ts, ConnectionID: o.ConnectionID, Buy: *o.Buy,
			Qty: *o.FillQty, Px: *o.FillPx, RefPx: o.RefPx, SlippageBps: o.SlippageBps, LatencyMs: o.LatencyMs,
			ReduceOnly: o.ReduceOnly, Purpose: o.Purpose,
		})
	}

	out := TaskChart{Base: base, Interval: a.Interval, Bases: bases, Candles: []exchange.Candle{}, Fills: fills}
	end := util.NowMs()
	candles, err := hlCandles(ctx, s, base, a.Interval, end-step*chartBars, end)
	if err != nil {
		msg := err.Error()
		out.CandleError = &msg
	} else {
		out.Candles = candles
	}
	return out, nil
}

// hlCandles loads bars from Hyperliquid's public feed, which lists nearly
// every perp the other venues do; the base is mapped to the venue's coin name.
func hlCandles(ctx context.Context, s *Server, base, interval string, start, end int64) ([]exchange.Candle, error) {
	hl, err := exchange.NewHyperliquidPublic("0x0000000000000000000000000000000000000000", false, "")
	if err != nil {
		return nil, err
	}
	m, err := s.E.Markets(ctx, hl)
	if err != nil {
		return nil, err
	}
	spec := m.Base(base)
	if spec == nil {
		return nil, errs.Msg("Hyperliquid 没有 %s 合约，无法显示 K 线", base)
	}
	cs, err := hl.Candles(ctx, spec.Symbol, interval, start, end)
	if err != nil {
		return nil, err
	}
	// "kPEPE"-style contracts quote 1000 coins; fills are stored per coin.
	if unit, _ := spec.PxUnit.Float64(); unit > 0 && unit != 1 {
		for i := range cs {
			cs[i].O /= unit
			cs[i].H /= unit
			cs[i].L /= unit
			cs[i].C /= unit
		}
	}
	return cs, nil
}
