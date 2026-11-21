package store

import (
	"context"
	"database/sql"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/util"
)

// TaskPositionRow is one task's virtual share of a coin on a follower account.
type TaskPositionRow struct {
	TaskID       string
	ConnectionID string
	Base         string
	Size         string
	AvgPx        string
	Realized     string
	UpdatedAt    int64
	// Running totals of the open round trip (engine-defined JSON).
	TripJSON *string
	// Cumulative fees paid and funding received.
	Fees, Funding string
}

const taskPositionCols = "task_id, connection_id, base, size, avg_px, realized, updated_at, trip_json, fees, funding"

func scanTaskPosition(s interface{ Scan(...any) error }) (TaskPositionRow, error) {
	var p TaskPositionRow
	err := s.Scan(&p.TaskID, &p.ConnectionID, &p.Base, &p.Size, &p.AvgPx, &p.Realized, &p.UpdatedAt, &p.TripJSON, &p.Fees, &p.Funding)
	return p, err
}

// TaskPositions lists ledger rows, of one task or (taskID == "") of all.
func TaskPositions(ctx context.Context, db *sql.DB, taskID string) ([]TaskPositionRow, error) {
	q, args := "SELECT "+taskPositionCols+" FROM task_positions", []any{}
	if taskID != "" {
		q, args = q+" WHERE task_id = ?", append(args, taskID)
	}
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TaskPositionRow
	for rows.Next() {
		p, err := scanTaskPosition(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func UpsertTaskPosition(ctx context.Context, db *sql.DB, p *TaskPositionRow) error {
	if p.Fees == "" {
		p.Fees = "0"
	}
	if p.Funding == "" {
		p.Funding = "0"
	}
	_, err := db.ExecContext(ctx, `INSERT INTO task_positions (`+taskPositionCols+`) VALUES (?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(task_id, connection_id, base) DO UPDATE SET size = excluded.size, avg_px = excluded.avg_px, realized = excluded.realized, updated_at = excluded.updated_at, trip_json = excluded.trip_json, fees = excluded.fees, funding = excluded.funding`,
		p.TaskID, p.ConnectionID, p.Base, p.Size, p.AvgPx, p.Realized, p.UpdatedAt, p.TripJSON, p.Fees, p.Funding)
	return err
}

func DeleteTaskLedger(ctx context.Context, db *sql.DB, taskID string) error {
	for _, q := range []string{"DELETE FROM task_positions WHERE task_id = ?", "DELETE FROM task_pnl WHERE task_id = ?", "DELETE FROM task_trips WHERE task_id = ?", "DELETE FROM task_costs WHERE task_id = ?"} {
		if _, err := db.ExecContext(ctx, q, taskID); err != nil {
			return err
		}
	}
	return nil
}

func InsertTaskPnl(ctx context.Context, db *sql.DB, taskID string, pnl decimal.Decimal) error {
	_, err := db.ExecContext(ctx, "INSERT INTO task_pnl (task_id, ts, pnl) VALUES (?, ?, ?)", taskID, util.NowMs(), r4(pnl))
	return err
}

// TaskPnlPoint is one sample of a task's cumulative PnL.
type TaskPnlPoint struct {
	Ts  int64
	Pnl float64
}

// TaskPnlSeries returns a task's samples from `since` on, preceded by the last
// one before it (the opening value), oldest first.
func TaskPnlSeries(ctx context.Context, db *sql.DB, taskID string, since int64) ([]TaskPnlPoint, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT ts, CAST(pnl AS REAL) FROM (SELECT ts, pnl FROM task_pnl WHERE task_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1)
		UNION ALL
		SELECT ts, CAST(pnl AS REAL) FROM task_pnl WHERE task_id = ? AND ts >= ?
		ORDER BY ts`, taskID, since, taskID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TaskPnlPoint
	for rows.Next() {
		var p TaskPnlPoint
		if err := rows.Scan(&p.Ts, &p.Pnl); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// TaskPnlAt is a task's cumulative PnL as of t: the last sample at or before
// it, or zero (no ledger PnL yet).
func TaskPnlAt(ctx context.Context, db *sql.DB, taskID string, t int64) (decimal.Decimal, error) {
	var s string
	err := db.QueryRowContext(ctx, "SELECT pnl FROM task_pnl WHERE task_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1", taskID, t).Scan(&s)
	if err == sql.ErrNoRows {
		return decimal.Zero, nil
	}
	if err != nil {
		return decimal.Zero, err
	}
	return util.Dec(s), nil
}

// TripRow is one closed round trip of a task's share of a coin.
type TripRow struct {
	ID           int64   `json:"id"`
	TaskID       string  `json:"task_id"`
	ConnectionID string  `json:"connection_id"`
	Base         string  `json:"base"`
	Side         string  `json:"side"` // long | short
	OpenedAt     int64   `json:"opened_at"`
	ClosedAt     int64   `json:"closed_at"`
	MaxSize      string  `json:"max_size"`
	EntryPx      string  `json:"entry_px"`
	ExitPx       string  `json:"exit_px"`
	Realized     string  `json:"realized"`
	Leverage     *string `json:"leverage"`
	// sync | reconcile | close | tp | sl | trail | mirror | account | release | close_all
	Reason string  `json:"reason"`
	Note   *string `json:"note"`
	// Fees paid and funding received over the trip (Realized is gross).
	Fees    string `json:"fees"`
	Funding string `json:"funding"`
}

const tripCols = "id, task_id, connection_id, base, side, opened_at, closed_at, max_size, entry_px, exit_px, realized, leverage, reason, note, fees, funding"

func scanTrip(s interface{ Scan(...any) error }) (TripRow, error) {
	var t TripRow
	err := s.Scan(&t.ID, &t.TaskID, &t.ConnectionID, &t.Base, &t.Side, &t.OpenedAt, &t.ClosedAt, &t.MaxSize, &t.EntryPx, &t.ExitPx, &t.Realized, &t.Leverage, &t.Reason, &t.Note, &t.Fees, &t.Funding)
	return t, err
}

func InsertTrip(ctx context.Context, db *sql.DB, t *TripRow) error {
	if t.Fees == "" {
		t.Fees = "0"
	}
	if t.Funding == "" {
		t.Funding = "0"
	}
	_, err := db.ExecContext(ctx, `INSERT INTO task_trips (task_id, connection_id, base, side, opened_at, closed_at, max_size, entry_px, exit_px, realized, leverage, reason, note, fees, funding)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		t.TaskID, t.ConnectionID, t.Base, t.Side, t.OpenedAt, t.ClosedAt, t.MaxSize, t.EntryPx, t.ExitPx, t.Realized, t.Leverage, t.Reason, t.Note, t.Fees, t.Funding)
	return err
}

// AddTripCost adds a cost that settled after its round trip was recorded (the
// closing fill's fee, the last funding hour) to the trip it falls in.
// Returns false when no trip covers ts.
func AddTripCost(ctx context.Context, db *sql.DB, task, conn, base, kind string, amount decimal.Decimal, ts int64) (bool, error) {
	col := "fees"
	if kind == "funding" {
		col = "funding"
	}
	var id int64
	var cur string
	err := db.QueryRowContext(ctx, `SELECT id, `+col+` FROM task_trips WHERE task_id = ? AND connection_id = ? AND base = ? AND opened_at <= ? AND closed_at >= ?
		ORDER BY closed_at DESC LIMIT 1`, task, conn, base, ts+costSlackMs, ts-costSlackMs).Scan(&id, &cur)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	_, err = db.ExecContext(ctx, "UPDATE task_trips SET "+col+" = ? WHERE id = ?", util.Fmt(util.Dec(cur).Add(amount).RoundBank(8)), id)
	return err == nil, err
}

// Fills are booked when the order call returns; the venue's fill time can be
// a little earlier or later than our clock.
const costSlackMs = 10_000

// CostRow is one fee or funding payment of a task.
type CostRow struct {
	ID           int64   `json:"id"`
	TaskID       string  `json:"task_id"`
	ConnectionID string  `json:"connection_id"`
	Base         string  `json:"base"`
	Ts           int64   `json:"ts"`
	Kind         string  `json:"kind"` // fee | funding
	Amount       string  `json:"amount"`
	Rate         *string `json:"rate"`
	Qty          *string `json:"qty"`
	Px           *string `json:"px"`
	Maker        *bool   `json:"maker"`
	Dir          *string `json:"dir"`
	OrderID      *int64  `json:"order_id"`
	Ref          string  `json:"-"`
	// Joined from the order (fees): its purpose and note.
	Purpose *string `json:"purpose"`
	Reason  *string `json:"reason"`
}

const costCols = "c.id, c.task_id, c.connection_id, c.base, c.ts, c.kind, c.amount, c.rate, c.qty, c.px, c.maker, c.dir, c.order_id, c.ref, o.purpose, o.reason"

func scanCost(s interface{ Scan(...any) error }) (CostRow, error) {
	var c CostRow
	err := s.Scan(&c.ID, &c.TaskID, &c.ConnectionID, &c.Base, &c.Ts, &c.Kind, &c.Amount, &c.Rate, &c.Qty, &c.Px, &c.Maker, &c.Dir, &c.OrderID, &c.Ref, &c.Purpose, &c.Reason)
	return c, err
}

// InsertCost stores a cost once per ref; false = already recorded.
func InsertCost(ctx context.Context, db *sql.DB, c *CostRow) (bool, error) {
	res, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO task_costs (task_id, connection_id, base, ts, kind, amount, rate, qty, px, maker, dir, order_id, ref)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, c.TaskID, c.ConnectionID, c.Base, c.Ts, c.Kind, c.Amount, c.Rate, c.Qty, c.Px, c.Maker, c.Dir, c.OrderID, c.Ref)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// Costs lists cost rows; q is the SQL after FROM task_costs (aliased c).
func Costs(ctx context.Context, db *sql.DB, q string, args ...any) ([]CostRow, error) {
	return queryAll(ctx, db, asScan(scanCost), "SELECT "+costCols+" FROM task_costs c LEFT JOIN orders o ON o.id = c.order_id "+q, args...)
}

// CostTotals sums a task's costs from `since` on.
type CostTotals struct {
	Fees       float64 `json:"fees"`
	TakerFees  float64 `json:"taker_fees"`
	Funding    float64 `json:"funding"`
	FundingIn  float64 `json:"funding_in"`
	FundingOut float64 `json:"funding_out"`
	Fills      int64   `json:"fills"`
	TakerFills int64   `json:"taker_fills"`
}

func TaskCostTotals(ctx context.Context, db *sql.DB, task string, since int64) (CostTotals, error) {
	var t CostTotals
	err := db.QueryRowContext(ctx, `SELECT
		COALESCE(SUM(CASE WHEN kind = 'fee' THEN CAST(amount AS REAL) END), 0),
		COALESCE(SUM(CASE WHEN kind = 'fee' AND COALESCE(maker, 0) = 0 THEN CAST(amount AS REAL) END), 0),
		COALESCE(SUM(CASE WHEN kind = 'funding' THEN CAST(amount AS REAL) END), 0),
		COALESCE(SUM(CASE WHEN kind = 'funding' AND CAST(amount AS REAL) > 0 THEN CAST(amount AS REAL) END), 0),
		COALESCE(SUM(CASE WHEN kind = 'funding' AND CAST(amount AS REAL) < 0 THEN CAST(amount AS REAL) END), 0),
		COUNT(CASE WHEN kind = 'fee' THEN 1 END),
		COUNT(CASE WHEN kind = 'fee' AND COALESCE(maker, 0) = 0 THEN 1 END)
		FROM task_costs WHERE task_id = ? AND ts >= ?`, task, since).Scan(&t.Fees, &t.TakerFees, &t.Funding, &t.FundingIn, &t.FundingOut, &t.Fills, &t.TakerFills)
	return t, err
}

// OrderRef is a task's order on an account, found by its client id.
type OrderRef struct {
	ID      int64
	TaskID  string
	Purpose string
}

// OrdersByClientID maps the client ids of an account's orders since `since`.
func OrdersByClientID(ctx context.Context, db *sql.DB, conn string, since int64) (map[string]OrderRef, error) {
	rows, err := db.QueryContext(ctx, "SELECT id, task_id, purpose, client_id FROM orders WHERE connection_id = ? AND client_id IS NOT NULL AND ts >= ?", conn, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]OrderRef{}
	for rows.Next() {
		var o OrderRef
		var cid string
		if err := rows.Scan(&o.ID, &o.TaskID, &o.Purpose, &cid); err != nil {
			return nil, err
		}
		if prev, ok := out[cid]; !ok || prev.ID < o.ID {
			out[cid] = o
		}
	}
	return out, rows.Err()
}

// AddOrderFee adds a fill's fee to its order row.
func AddOrderFee(ctx context.Context, db *sql.DB, id int64, fee decimal.Decimal) error {
	_, err := db.ExecContext(ctx, "UPDATE orders SET fee = CAST(CAST(COALESCE(fee, '0') AS REAL) + ? AS TEXT) WHERE id = ?", fee.InexactFloat64(), id)
	return err
}

// Trips lists closed round trips; q is the SQL after FROM task_trips.
func Trips(ctx context.Context, db *sql.DB, q string, args ...any) ([]TripRow, error) {
	return queryAll(ctx, db, asScan(scanTrip), "SELECT "+tripCols+" FROM task_trips "+q, args...)
}
