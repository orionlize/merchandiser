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
}

const taskPositionCols = "task_id, connection_id, base, size, avg_px, realized, updated_at"

func scanTaskPosition(s interface{ Scan(...any) error }) (TaskPositionRow, error) {
	var p TaskPositionRow
	err := s.Scan(&p.TaskID, &p.ConnectionID, &p.Base, &p.Size, &p.AvgPx, &p.Realized, &p.UpdatedAt)
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
	_, err := db.ExecContext(ctx, `INSERT INTO task_positions (`+taskPositionCols+`) VALUES (?,?,?,?,?,?,?)
		ON CONFLICT(task_id, connection_id, base) DO UPDATE SET size = excluded.size, avg_px = excluded.avg_px, realized = excluded.realized, updated_at = excluded.updated_at`,
		p.TaskID, p.ConnectionID, p.Base, p.Size, p.AvgPx, p.Realized, p.UpdatedAt)
	return err
}

func DeleteTaskLedger(ctx context.Context, db *sql.DB, taskID string) error {
	for _, q := range []string{"DELETE FROM task_positions WHERE task_id = ?", "DELETE FROM task_pnl WHERE task_id = ?"} {
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
