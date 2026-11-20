// Package store is the SQLite persistence: connections, sources, tasks,
// signals, orders, mirrors, equity samples, alerts and settings.
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/shopspring/decimal"
	_ "modernc.org/sqlite"

	"merchandiser/server/internal/util"
)

//go:embed migrations/*.sql
var migrations embed.FS

type DB = sql.DB

// Open opens (and migrates) dir/merchandiser.db. The schema is the one the
// desktop build used, so an existing database file can be dropped in.
func Open(dir string) (*sql.DB, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "merchandiser.db")
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_txlock=immediate", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("迁移失败: %w", err)
	}
	return db, nil
}

func migrate(db *sql.DB) error {
	init, err := migrations.ReadFile("migrations/0001_init.sql")
	if err != nil {
		return err
	}
	if _, err := db.Exec(string(init)); err != nil {
		return err
	}
	has, err := hasColumn(db, "sources", "lead_mode")
	if err != nil {
		return err
	}
	if !has {
		m2, err := migrations.ReadFile("migrations/0002_lead_fills.sql")
		if err != nil {
			return err
		}
		if _, err := db.Exec(string(m2)); err != nil {
			return err
		}
	} else {
		if _, err := db.Exec("CREATE TABLE IF NOT EXISTS lead_fill_state (source_id TEXT PRIMARY KEY, json TEXT NOT NULL)"); err != nil {
			return err
		}
	}
	if has, err = hasColumn(db, "signals", "src_px"); err != nil {
		return err
	} else if !has {
		m3, err := migrations.ReadFile("migrations/0003_signal_source.sql")
		if err != nil {
			return err
		}
		if _, err := db.Exec(string(m3)); err != nil {
			return err
		}
	}
	has, err = hasColumn(db, "sources", "lead_poll")
	if err != nil {
		return err
	}
	if !has {
		m4, err := migrations.ReadFile("migrations/0004_lead_poll.sql")
		if err != nil {
			return err
		}
		if _, err := db.Exec(string(m4)); err != nil {
			return err
		}
	}
	if has, err = hasColumn(db, "task_positions", "realized"); err != nil {
		return err
	} else if !has {
		m5, err := migrations.ReadFile("migrations/0005_task_ledger.sql")
		if err != nil {
			return err
		}
		if _, err := db.Exec(string(m5)); err != nil {
			return err
		}
	}
	return nil
}

func hasColumn(db *sql.DB, table, col string) (bool, error) {
	rows, err := db.Query("SELECT name FROM pragma_table_info(?)", table)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return false, err
		}
		if strings.EqualFold(n, col) {
			return true, nil
		}
	}
	return false, rows.Err()
}

// ---------- rows ----------

type ConnectionRow struct {
	ID           string  `json:"id"`
	Platform     string  `json:"platform"`
	Alias        string  `json:"alias"`
	Testnet      bool    `json:"testnet"`
	KeyHint      string  `json:"key_hint"`
	Proxy        *string `json:"proxy"`
	PermsJSON    *string `json:"perms_json"`
	OneWay       *bool   `json:"one_way"`
	MarginMode   *string `json:"margin_mode"`
	PaperInitial *string `json:"paper_initial"`
	CreatedAt    int64   `json:"created_at"`
}

const connCols = "id, platform, alias, testnet, key_hint, proxy, perms_json, one_way, margin_mode, paper_initial, created_at"

func scanConn(s interface{ Scan(...any) error }) (ConnectionRow, error) {
	var c ConnectionRow
	err := s.Scan(&c.ID, &c.Platform, &c.Alias, &c.Testnet, &c.KeyHint, &c.Proxy, &c.PermsJSON, &c.OneWay, &c.MarginMode, &c.PaperInitial, &c.CreatedAt)
	return c, err
}

type SourceRow struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"`
	Name         string  `json:"name"`
	Platform     string  `json:"platform"`
	ConnectionID *string `json:"connection_id"`
	Address      *string `json:"address"`
	Testnet      bool    `json:"testnet"`
	CreatedAt    int64   `json:"created_at"`
}

const sourceCols = "id, kind, name, platform, connection_id, address, testnet, created_at"

func scanSource(s interface{ Scan(...any) error }) (SourceRow, error) {
	var r SourceRow
	err := s.Scan(&r.ID, &r.Kind, &r.Name, &r.Platform, &r.ConnectionID, &r.Address, &r.Testnet, &r.CreatedAt)
	return r, err
}

func (s *SourceRow) Addr() string {
	if s.Address == nil {
		return ""
	}
	return *s.Address
}

type TaskRow struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	SourceID     string  `json:"source_id"`
	Status       string  `json:"status"`
	RulesJSON    string  `json:"rules_json"`
	RiskJSON     string  `json:"risk_json"`
	PauseReason  *string `json:"pause_reason"`
	BaselineJSON *string `json:"baseline_json"`
	CreatedAt    int64   `json:"created_at"`
	StartedAt    *int64  `json:"started_at"`
	StoppedAt    *int64  `json:"stopped_at"`
}

const taskCols = "id, name, source_id, status, rules_json, risk_json, pause_reason, baseline_json, created_at, started_at, stopped_at"

func scanTask(s interface{ Scan(...any) error }) (TaskRow, error) {
	var t TaskRow
	err := s.Scan(&t.ID, &t.Name, &t.SourceID, &t.Status, &t.RulesJSON, &t.RiskJSON, &t.PauseReason, &t.BaselineJSON, &t.CreatedAt, &t.StartedAt, &t.StoppedAt)
	return t, err
}

type FollowerRow struct {
	TaskID       string  `json:"task_id"`
	ConnectionID string  `json:"connection_id"`
	OverrideJSON *string `json:"override_json"`
	StartEquity  *string `json:"start_equity"`
}

type SignalRow struct {
	ID       int64   `json:"id"`
	TaskID   string  `json:"task_id"`
	Ts       int64   `json:"ts"`
	Base     string  `json:"base"`
	Kind     string  `json:"kind"`
	FromSize *string `json:"from_size"`
	ToSize   *string `json:"to_size"`
	Text     string  `json:"text"`
	SignalSrc
}

// SignalSrc is what the source itself did at a signal (see migration 0003).
type SignalSrc struct {
	SrcTs       *int64  `json:"src_ts"`
	SrcPx       *string `json:"src_px"`
	SrcEntry    *string `json:"src_entry"`
	SrcEquity   *string `json:"src_equity"`
	SrcRealized *string `json:"src_realized"`
	SrcBasis    *string `json:"src_basis"`
}

type OrderRow struct {
	ID           int64   `json:"id"`
	TaskID       string  `json:"task_id"`
	SignalID     *int64  `json:"signal_id"`
	ConnectionID *string `json:"connection_id"`
	Ts           int64   `json:"ts"`
	Base         string  `json:"base"`
	Symbol       *string `json:"symbol"`
	Buy          *bool   `json:"buy"`
	Qty          *string `json:"qty"`
	OrderType    *string `json:"order_type"`
	Price        *string `json:"price"`
	ReduceOnly   bool    `json:"reduce_only"`
	ClientID     *string `json:"client_id"`
	Status       string  `json:"status"`
	FillPx       *string `json:"fill_px"`
	FillQty      *string `json:"fill_qty"`
	RefPx        *string `json:"ref_px"`
	SlippageBps  *string `json:"slippage_bps"`
	LatencyMs    *int64  `json:"latency_ms"`
	Reason       *string `json:"reason"`
	Purpose      string  `json:"purpose"`
}

const orderCols = "id, task_id, signal_id, connection_id, ts, base, symbol, buy, qty, order_type, price, reduce_only, client_id, status, fill_px, fill_qty, ref_px, slippage_bps, latency_ms, reason, purpose"

func scanOrder(s interface{ Scan(...any) error }) (OrderRow, error) {
	var o OrderRow
	err := s.Scan(&o.ID, &o.TaskID, &o.SignalID, &o.ConnectionID, &o.Ts, &o.Base, &o.Symbol, &o.Buy, &o.Qty, &o.OrderType, &o.Price, &o.ReduceOnly, &o.ClientID, &o.Status, &o.FillPx, &o.FillQty, &o.RefPx, &o.SlippageBps, &o.LatencyMs, &o.Reason, &o.Purpose)
	return o, err
}

type MirrorRow struct {
	ID            int64   `json:"id"`
	TaskID        string  `json:"task_id"`
	ConnectionID  string  `json:"connection_id"`
	SourceOrderID string  `json:"source_order_id"`
	ClientID      *string `json:"client_id"`
	Base          string  `json:"base"`
	Buy           bool    `json:"buy"`
	Kind          string  `json:"kind"`
	SrcQty        string  `json:"src_qty"`
	SrcPrice      *string `json:"src_price"`
	Qty           *string `json:"qty"`
	Price         *string `json:"price"`
	TriggerPx     *string `json:"trigger_px"`
	Filled        string  `json:"filled"`
	Status        string  `json:"status"`
	Note          *string `json:"note"`
	GraceUntil    *int64  `json:"grace_until"`
	CreatedAt     int64   `json:"created_at"`
	UpdatedAt     int64   `json:"updated_at"`
}

const mirrorCols = "id, task_id, connection_id, source_order_id, client_id, base, buy, kind, src_qty, src_price, qty, price, trigger_px, filled, status, note, grace_until, created_at, updated_at"

func scanMirror(s interface{ Scan(...any) error }) (MirrorRow, error) {
	var m MirrorRow
	err := s.Scan(&m.ID, &m.TaskID, &m.ConnectionID, &m.SourceOrderID, &m.ClientID, &m.Base, &m.Buy, &m.Kind, &m.SrcQty, &m.SrcPrice, &m.Qty, &m.Price, &m.TriggerPx, &m.Filled, &m.Status, &m.Note, &m.GraceUntil, &m.CreatedAt, &m.UpdatedAt)
	return m, err
}

type AlertRow struct {
	ID           int64   `json:"id"`
	Ts           int64   `json:"ts"`
	Level        string  `json:"level"`
	TaskID       *string `json:"task_id"`
	ConnectionID *string `json:"connection_id"`
	Title        string  `json:"title"`
	Detail       *string `json:"detail"`
}

// ---------- generic helpers ----------

type scanner interface{ Scan(...any) error }

func queryAll[T any](ctx context.Context, db *sql.DB, scan func(scanner) (T, error), q string, args ...any) ([]T, error) {
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func queryOne[T any](ctx context.Context, db *sql.DB, scan func(scanner) (T, error), q string, args ...any) (*T, error) {
	v, err := scan(db.QueryRowContext(ctx, q, args...))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func asScan[T any](f func(interface{ Scan(...any) error }) (T, error)) func(scanner) (T, error) {
	return func(s scanner) (T, error) { return f(s) }
}

// Count runs a COUNT(*) style query.
func Count(ctx context.Context, db *sql.DB, q string, args ...any) (int64, error) {
	var n int64
	err := db.QueryRowContext(ctx, q, args...).Scan(&n)
	return n, err
}

// ---------- settings ----------

func GetSetting(ctx context.Context, db *sql.DB, key string) (*string, error) {
	var v string
	err := db.QueryRowContext(ctx, "SELECT value FROM settings WHERE key = ?", key).Scan(&v)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func SetSetting(ctx context.Context, db *sql.DB, key, value string) error {
	_, err := db.ExecContext(ctx, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
	return err
}

func DeleteSetting(ctx context.Context, db *sql.DB, key string) error {
	_, err := db.ExecContext(ctx, "DELETE FROM settings WHERE key = ?", key)
	return err
}

// ---------- entities ----------

func Connections(ctx context.Context, db *sql.DB) ([]ConnectionRow, error) {
	return queryAll(ctx, db, asScan(scanConn), "SELECT "+connCols+" FROM connections ORDER BY created_at")
}

func Connection(ctx context.Context, db *sql.DB, id string) (*ConnectionRow, error) {
	return queryOne(ctx, db, asScan(scanConn), "SELECT "+connCols+" FROM connections WHERE id = ?", id)
}

func Sources(ctx context.Context, db *sql.DB) ([]SourceRow, error) {
	return queryAll(ctx, db, asScan(scanSource), "SELECT "+sourceCols+" FROM sources ORDER BY created_at")
}

func Source(ctx context.Context, db *sql.DB, id string) (*SourceRow, error) {
	return queryOne(ctx, db, asScan(scanSource), "SELECT "+sourceCols+" FROM sources WHERE id = ?", id)
}

func Tasks(ctx context.Context, db *sql.DB) ([]TaskRow, error) {
	return queryAll(ctx, db, asScan(scanTask), "SELECT "+taskCols+" FROM tasks ORDER BY created_at")
}

func Task(ctx context.Context, db *sql.DB, id string) (*TaskRow, error) {
	return queryOne(ctx, db, asScan(scanTask), "SELECT "+taskCols+" FROM tasks WHERE id = ?", id)
}

func Followers(ctx context.Context, db *sql.DB, taskID string) ([]FollowerRow, error) {
	return queryAll(ctx, db, func(s scanner) (FollowerRow, error) {
		var f FollowerRow
		err := s.Scan(&f.TaskID, &f.ConnectionID, &f.OverrideJSON, &f.StartEquity)
		return f, err
	}, "SELECT task_id, connection_id, override_json, start_equity FROM task_followers WHERE task_id = ? ORDER BY rowid", taskID)
}

func Signals(ctx context.Context, db *sql.DB, q string, args ...any) ([]SignalRow, error) {
	return queryAll(ctx, db, func(s scanner) (SignalRow, error) {
		var r SignalRow
		err := s.Scan(&r.ID, &r.TaskID, &r.Ts, &r.Base, &r.Kind, &r.FromSize, &r.ToSize, &r.Text, &r.SrcTs, &r.SrcPx, &r.SrcEntry, &r.SrcEquity, &r.SrcRealized, &r.SrcBasis)
		return r, err
	}, "SELECT id, task_id, ts, base, kind, from_size, to_size, text, src_ts, src_px, src_entry, src_equity, src_realized, src_basis FROM signals "+q, args...)
}

func Orders(ctx context.Context, db *sql.DB, q string, args ...any) ([]OrderRow, error) {
	return queryAll(ctx, db, asScan(scanOrder), "SELECT "+orderCols+" FROM orders "+q, args...)
}

func Mirrors(ctx context.Context, db *sql.DB, q string, args ...any) ([]MirrorRow, error) {
	return queryAll(ctx, db, asScan(scanMirror), "SELECT "+mirrorCols+" FROM mirrors "+q, args...)
}

func Alerts(ctx context.Context, db *sql.DB, limit int64) ([]AlertRow, error) {
	return queryAll(ctx, db, func(s scanner) (AlertRow, error) {
		var a AlertRow
		err := s.Scan(&a.ID, &a.Ts, &a.Level, &a.TaskID, &a.ConnectionID, &a.Title, &a.Detail)
		return a, err
	}, "SELECT id, ts, level, task_id, connection_id, title, detail FROM alerts ORDER BY ts DESC LIMIT ?", limit)
}

func SetTaskStatus(ctx context.Context, db *sql.DB, id, status string, reason *string) error {
	now := util.NowMs()
	var err error
	switch status {
	case "running":
		_, err = db.ExecContext(ctx, "UPDATE tasks SET status = ?, pause_reason = NULL, started_at = COALESCE(started_at, ?), stopped_at = NULL WHERE id = ?", status, now, id)
	case "stopped":
		_, err = db.ExecContext(ctx, "UPDATE tasks SET status = ?, pause_reason = ?, stopped_at = ? WHERE id = ?", status, reason, now, id)
	default:
		_, err = db.ExecContext(ctx, "UPDATE tasks SET status = ?, pause_reason = ? WHERE id = ?", status, reason, id)
	}
	return err
}

func decStr(d *decimal.Decimal) *string {
	if d == nil {
		return nil
	}
	s := util.Fmt(*d)
	return &s
}

func InsertSignal(ctx context.Context, db *sql.DB, taskID, base, kind string, from, to *decimal.Decimal, text string, src *SignalSrc) (int64, error) {
	if src == nil {
		src = &SignalSrc{}
	}
	r, err := db.ExecContext(ctx, "INSERT INTO signals (task_id, ts, base, kind, from_size, to_size, text, src_ts, src_px, src_entry, src_equity, src_realized, src_basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		taskID, util.NowMs(), base, kind, decStr(from), decStr(to), text, src.SrcTs, src.SrcPx, src.SrcEntry, src.SrcEquity, src.SrcRealized, src.SrcBasis)
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}

func InsertOrder(ctx context.Context, db *sql.DB, o *OrderRow) (int64, error) {
	ts := o.Ts
	if ts == 0 {
		ts = util.NowMs()
	}
	r, err := db.ExecContext(ctx, `INSERT INTO orders (task_id, signal_id, connection_id, ts, base, symbol, buy, qty, order_type, price, reduce_only, client_id, status, fill_px, fill_qty, ref_px, slippage_bps, latency_ms, reason, purpose)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		o.TaskID, o.SignalID, o.ConnectionID, ts, o.Base, o.Symbol, o.Buy, o.Qty, o.OrderType, o.Price, o.ReduceOnly, o.ClientID, o.Status, o.FillPx, o.FillQty, o.RefPx, o.SlippageBps, o.LatencyMs, o.Reason, o.Purpose)
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}

func InsertAlert(ctx context.Context, db *sql.DB, level string, taskID, connID *string, title string, detail *string) (int64, error) {
	r, err := db.ExecContext(ctx, "INSERT INTO alerts (ts, level, task_id, connection_id, title, detail) VALUES (?, ?, ?, ?, ?, ?)",
		util.NowMs(), level, taskID, connID, title, detail)
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}

func r4(d decimal.Decimal) string { return d.RoundBank(4).String() }

func InsertEquity(ctx context.Context, db *sql.DB, conn string, equity, available, upnl, notional decimal.Decimal) error {
	_, err := db.ExecContext(ctx, "INSERT INTO equity_snapshots (connection_id, ts, equity, available, upnl, notional) VALUES (?, ?, ?, ?, ?, ?)",
		conn, util.NowMs(), r4(equity), r4(available), r4(upnl), r4(notional))
	return err
}

// EquityLatest is the most recent equity sample of a connection.
type EquityLatest struct {
	Ts                                int64
	Equity, Available, Upnl, Notional string
}

// EquityBounds returns the latest equity row and the first equity at or after `since`.
func EquityBounds(ctx context.Context, db *sql.DB, conn string, since int64) (*EquityLatest, *string, error) {
	var l EquityLatest
	err := db.QueryRowContext(ctx, "SELECT ts, equity, available, upnl, notional FROM equity_snapshots WHERE connection_id = ? ORDER BY ts DESC LIMIT 1", conn).
		Scan(&l.Ts, &l.Equity, &l.Available, &l.Upnl, &l.Notional)
	var latest *EquityLatest
	if err == nil {
		latest = &l
	} else if err != sql.ErrNoRows {
		return nil, nil, err
	}
	var first string
	err = db.QueryRowContext(ctx, "SELECT equity FROM equity_snapshots WHERE connection_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1", conn, since).Scan(&first)
	if err == sql.ErrNoRows {
		return latest, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return latest, &first, nil
}

func Prune(ctx context.Context, db *sql.DB, retentionDays int64) error {
	cutoff := util.NowMs() - retentionDays*86_400_000
	for _, t := range []string{"signals", "orders", "alerts", "equity_snapshots", "source_equity", "task_pnl"} {
		if _, err := db.ExecContext(ctx, "DELETE FROM "+t+" WHERE ts < ?", cutoff); err != nil {
			return err
		}
	}
	_, err := db.ExecContext(ctx, "DELETE FROM mirrors WHERE status IN ('done','not_mirrored','failed') AND updated_at < ?", cutoff)
	return err
}
