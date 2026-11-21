package store

import (
	"context"
	"database/sql"
	"strings"
)

// OpLogRow is one entry of the operation audit log ("操作审计").
type OpLogRow struct {
	ID        int64   `json:"id"`
	Ts        int64   `json:"ts"`
	Command   string  `json:"command"`
	Summary   *string `json:"summary"`
	Ok        bool    `json:"ok"`
	Error     *string `json:"error"`
	IP        *string `json:"ip"`
	UA        *string `json:"ua"`
	Otp       bool    `json:"otp"`
	Sensitive bool    `json:"sensitive"`
}

const opLogCols = "id, ts, command, summary, ok, error, ip, ua, otp, sensitive"

func scanOpLog(s interface{ Scan(...any) error }) (OpLogRow, error) {
	var r OpLogRow
	err := s.Scan(&r.ID, &r.Ts, &r.Command, &r.Summary, &r.Ok, &r.Error, &r.IP, &r.UA, &r.Otp, &r.Sensitive)
	return r, err
}

func InsertOpLog(ctx context.Context, db *sql.DB, r *OpLogRow) error {
	_, err := db.ExecContext(ctx, "INSERT INTO op_log (ts, command, summary, ok, error, ip, ua, otp, sensitive) VALUES (?,?,?,?,?,?,?,?,?)",
		r.Ts, r.Command, r.Summary, r.Ok, r.Error, r.IP, r.UA, r.Otp, r.Sensitive)
	return err
}

// OpLogFilter narrows the audit log; zero values match everything.
type OpLogFilter struct {
	Since     int64  `json:"since"`
	Until     int64  `json:"until"`
	Sensitive bool   `json:"sensitive"`
	Failed    bool   `json:"failed"`
	Query     string `json:"query"`
	Limit     int64  `json:"limit"`
}

// OpLog lists audit entries, newest first.
func OpLog(ctx context.Context, db *sql.DB, f OpLogFilter) ([]OpLogRow, error) {
	var where []string
	var args []any
	if f.Since > 0 {
		where, args = append(where, "ts >= ?"), append(args, f.Since)
	}
	if f.Until > 0 {
		where, args = append(where, "ts < ?"), append(args, f.Until)
	}
	if f.Sensitive {
		where = append(where, "sensitive = 1")
	}
	if f.Failed {
		where = append(where, "ok = 0")
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(q) + "%"
		where = append(where, `(command LIKE ? ESCAPE '\' OR summary LIKE ? ESCAPE '\' OR ip LIKE ? ESCAPE '\')`)
		args = append(args, like, like, like)
	}
	q := "ORDER BY ts DESC, id DESC LIMIT ?"
	if len(where) > 0 {
		q = "WHERE " + strings.Join(where, " AND ") + " " + q
	}
	limit := f.Limit
	if limit <= 0 || limit > 5000 {
		limit = 500
	}
	return queryAll(ctx, db, asScan(scanOpLog), "SELECT "+opLogCols+" FROM op_log "+q, append(args, limit)...)
}
