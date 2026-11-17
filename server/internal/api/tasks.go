package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/engine"
	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

type FollowerSpec struct {
	ConnectionID string                   `json:"connection_id"`
	Overrides    *engine.FollowerOverride `json:"overrides"`
}

type TaskInput struct {
	Name      string         `json:"name"`
	SourceID  string         `json:"source_id"`
	Followers []FollowerSpec `json:"followers"`
	Rules     engine.Rules   `json:"rules"`
	Risk      engine.Risk    `json:"risk"`
	StartNow  bool           `json:"start_now"`
}

func validateRules(r *engine.Rules) error {
	switch r.Sizing.Mode {
	case engine.EquityRatio, engine.FixedMultiple:
		if !r.Sizing.K.IsPositive() || r.Sizing.K.GreaterThan(util.Hundred) {
			return errs.Msg("倍数应在 0–100 之间")
		}
	case engine.FixedNotional:
		if !r.Sizing.Notional.IsPositive() {
			return errs.Msg("固定名义金额应大于 0")
		}
	default:
		return errs.Msg("未知仓位计算方式")
	}
	if r.Leverage.Cap == 0 {
		return errs.Msg("杠杆上限应 ≥ 1")
	}
	return nil
}

// checkSourceSizing: OKX lead traders expose no equity, so equity-ratio sizing cannot work.
func checkSourceSizing(ctx context.Context, s *Server, sourceID string, rules *engine.Rules, followers []FollowerSpec) error {
	src, err := store.Source(ctx, s.E.DB, sourceID)
	if err != nil || src == nil {
		return err
	}
	if !(src.Kind == "lead_trader" && src.Platform == "okx") {
		return nil
	}
	bad := rules != nil && rules.Sizing.Mode == engine.EquityRatio
	for _, f := range followers {
		if f.Overrides != nil && f.Overrides.Sizing != nil && f.Overrides.Sizing.Mode == engine.EquityRatio {
			bad = true
		}
	}
	if bad {
		return errs.Msg("OKX 带单员不公开权益，不能按权益比例跟单，请改用固定倍数或固定名义金额")
	}
	return nil
}

func overrideJSON(o *engine.FollowerOverride) (*string, error) {
	if o == nil {
		return nil, nil
	}
	b, err := json.Marshal(o)
	if err != nil {
		return nil, err
	}
	return util.Ptr(string(b)), nil
}

func createTask(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Input TaskInput `json:"input"`
	}](body)
	if err != nil {
		return nil, err
	}
	in := a.Input
	if err := validateRules(&in.Rules); err != nil {
		return nil, err
	}
	if len(in.Followers) == 0 {
		return nil, errs.Msg("至少选择一个跟单账户")
	}
	db := s.E.DB
	src, err := store.Source(ctx, db, in.SourceID)
	if err != nil {
		return nil, err
	}
	if src == nil {
		return nil, errs.Msg("信号源不存在")
	}
	if err := checkSourceSizing(ctx, s, in.SourceID, &in.Rules, in.Followers); err != nil {
		return nil, err
	}
	for _, f := range in.Followers {
		if src.ConnectionID != nil && *src.ConnectionID == f.ConnectionID {
			return nil, errs.Msg("跟单账户不能与信号源是同一个连接")
		}
	}
	rules, _ := json.Marshal(in.Rules)
	risk, _ := json.Marshal(in.Risk)
	id := util.NewUUID()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "INSERT INTO tasks (id, name, source_id, status, rules_json, risk_json, created_at) VALUES (?,?,?,?,?,?,?)",
		id, strings.TrimSpace(in.Name), in.SourceID, "paused", string(rules), string(risk), util.NowMs()); err != nil {
		return nil, err
	}
	for _, f := range in.Followers {
		oj, err := overrideJSON(f.Overrides)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO task_followers (task_id, connection_id, override_json) VALUES (?,?,?)", id, f.ConnectionID, oj); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if in.StartNow {
		if err := s.E.StartTask(ctx, id, true); err != nil {
			return nil, err
		}
	} else if err := store.SetTaskStatus(ctx, db, id, "paused", util.Ptr("尚未启动")); err != nil {
		return nil, err
	}
	s.E.Changed("tasks")
	return id, nil
}

func updateTask(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		ID     string `json:"id"`
		Update struct {
			Name      *string         `json:"name"`
			Rules     *engine.Rules   `json:"rules"`
			Risk      *engine.Risk    `json:"risk"`
			Followers *[]FollowerSpec `json:"followers"`
		} `json:"update"`
	}](body)
	if err != nil {
		return nil, err
	}
	u, id, db := a.Update, a.ID, s.E.DB
	if u.Rules != nil || u.Followers != nil {
		t, err := store.Task(ctx, db, id)
		if err != nil {
			return nil, err
		}
		if t == nil {
			return nil, errs.Msg("任务不存在")
		}
		rules := u.Rules
		if rules == nil {
			rules = &engine.Rules{}
			if err := json.Unmarshal([]byte(t.RulesJSON), rules); err != nil {
				return nil, err
			}
		}
		var fs []FollowerSpec
		if u.Followers != nil {
			fs = *u.Followers
		}
		if err := checkSourceSizing(ctx, s, t.SourceID, rules, fs); err != nil {
			return nil, err
		}
	}
	if u.Name != nil {
		if _, err := db.ExecContext(ctx, "UPDATE tasks SET name=? WHERE id=?", strings.TrimSpace(*u.Name), id); err != nil {
			return nil, err
		}
	}
	if u.Rules != nil {
		if err := validateRules(u.Rules); err != nil {
			return nil, err
		}
		b, _ := json.Marshal(u.Rules)
		if _, err := db.ExecContext(ctx, "UPDATE tasks SET rules_json=? WHERE id=?", string(b), id); err != nil {
			return nil, err
		}
	}
	if u.Risk != nil {
		b, _ := json.Marshal(u.Risk)
		if _, err := db.ExecContext(ctx, "UPDATE tasks SET risk_json=? WHERE id=?", string(b), id); err != nil {
			return nil, err
		}
	}
	if u.Followers != nil {
		fs := *u.Followers
		if len(fs) == 0 {
			return nil, errs.Msg("至少保留一个跟单账户")
		}
		old, err := store.Followers(ctx, db, id)
		if err != nil {
			return nil, err
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, "DELETE FROM task_followers WHERE task_id=?", id); err != nil {
			return nil, err
		}
		for _, f := range fs {
			var se *string
			for _, o := range old {
				if o.ConnectionID == f.ConnectionID {
					se = o.StartEquity
				}
			}
			oj, err := overrideJSON(f.Overrides)
			if err != nil {
				return nil, err
			}
			if _, err := tx.ExecContext(ctx, "INSERT INTO task_followers (task_id, connection_id, override_json, start_equity) VALUES (?,?,?,?)", id, f.ConnectionID, oj, se); err != nil {
				return nil, err
			}
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
	}
	s.E.ReloadTask(id)
	s.E.Changed("tasks")
	return nil, nil
}

func taskAction(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		ID             string `json:"id"`
		Action         string `json:"action"`
		ClosePositions *bool  `json:"close_positions"`
	}](body)
	if err != nil {
		return nil, err
	}
	e := s.E
	switch a.Action {
	case "start":
		return nil, e.StartTask(ctx, a.ID, true)
	case "resume":
		return nil, e.StartTask(ctx, a.ID, false)
	case "pause":
		return nil, e.PauseTask(ctx, a.ID, util.Ptr("手动暂停"))
	case "stop":
		return nil, e.StopTask(ctx, a.ID, a.ClosePositions)
	case "reconcile":
		return nil, e.ReconcileNow(a.ID)
	}
	return nil, errs.Msg("未知操作")
}

func deleteTask(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[idArg](body)
	if err != nil {
		return nil, err
	}
	db := s.E.DB
	t, err := store.Task(ctx, db, a.ID)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, errs.Msg("任务不存在")
	}
	if t.Status != "stopped" {
		return nil, errs.Msg("请先停止任务")
	}
	for _, q := range []string{"DELETE FROM task_followers WHERE task_id=?", "DELETE FROM mirrors WHERE task_id=?", "DELETE FROM tasks WHERE id=?"} {
		if _, err := db.ExecContext(ctx, q, a.ID); err != nil {
			return nil, err
		}
	}
	s.E.Changed("tasks")
	return nil, nil
}

type FollowerDto struct {
	ConnectionID string                   `json:"connection_id"`
	Alias        string                   `json:"alias"`
	Platform     string                   `json:"platform"`
	Testnet      bool                     `json:"testnet"`
	Overrides    *engine.FollowerOverride `json:"overrides"`
}

type TaskSummary struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	Status         string           `json:"status"`
	PauseReason    *string          `json:"pause_reason"`
	SourceID       string           `json:"source_id"`
	SourceName     string           `json:"source_name"`
	SourceKind     string           `json:"source_kind"`
	SourcePlatform string           `json:"source_platform"`
	SourceAddress  *string          `json:"source_address"`
	Followers      []FollowerDto    `json:"followers"`
	Rules          engine.Rules     `json:"rules"`
	Risk           engine.Risk      `json:"risk"`
	CreatedAt      int64            `json:"created_at"`
	StartedAt      *int64           `json:"started_at"`
	StoppedAt      *int64           `json:"stopped_at"`
	TodayPnl       *string          `json:"today_pnl"`
	TotalPnl       *string          `json:"total_pnl"`
	Live           *engine.TaskLive `json:"live"`
	// Source position changes over the last 7 days: opens and adds, trims and closes.
	WeekAdds    int64 `json:"week_adds"`
	WeekReduces int64 `json:"week_reduces"`
}

func summarize(ctx context.Context, s *Server, t *store.TaskRow) (*TaskSummary, error) {
	db := s.E.DB
	src, err := store.Source(ctx, db, t.SourceID)
	if err != nil {
		return nil, err
	}
	since := util.StartOfTodayMs()
	if t.StartedAt != nil && *t.StartedAt > since {
		since = *t.StartedAt
	}
	frows, err := store.Followers(ctx, db, t.ID)
	if err != nil {
		return nil, err
	}
	followers := []FollowerDto{}
	today, total := decimal.Zero, decimal.Zero
	have := false
	for _, f := range frows {
		c, err := store.Connection(ctx, db, f.ConnectionID)
		if err != nil {
			return nil, err
		}
		latest, first, err := store.EquityBounds(ctx, db, f.ConnectionID, since)
		if err != nil {
			return nil, err
		}
		if latest != nil {
			have = true
			if first != nil {
				today = today.Add(util.Dec(latest.Equity).Sub(util.Dec(*first)))
			}
			if f.StartEquity != nil {
				total = total.Add(util.Dec(latest.Equity).Sub(util.Dec(*f.StartEquity)))
			}
		}
		fd := FollowerDto{ConnectionID: f.ConnectionID}
		if c != nil {
			fd.Alias, fd.Platform, fd.Testnet = c.Alias, c.Platform, c.Testnet
		}
		if f.OverrideJSON != nil {
			var o engine.FollowerOverride
			if json.Unmarshal([]byte(*f.OverrideJSON), &o) == nil {
				fd.Overrides = &o
			}
		}
		followers = append(followers, fd)
	}
	sum := &TaskSummary{
		ID: t.ID, Name: t.Name, Status: t.Status, PauseReason: t.PauseReason, SourceID: t.SourceID,
		Followers: followers, CreatedAt: t.CreatedAt, StartedAt: t.StartedAt, StoppedAt: t.StoppedAt, Live: s.E.Live(t.ID),
	}
	if err := json.Unmarshal([]byte(t.RulesJSON), &sum.Rules); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(t.RiskJSON), &sum.Risk); err != nil {
		return nil, err
	}
	if src != nil {
		sum.SourceName, sum.SourceKind, sum.SourcePlatform, sum.SourceAddress = src.Name, src.Kind, src.Platform, src.Address
	}
	if err := db.QueryRowContext(ctx, `SELECT
		COALESCE(SUM(kind IN ('open','add','flip')), 0), COALESCE(SUM(kind IN ('reduce','close')), 0)
		FROM signals WHERE task_id = ? AND ts >= ?`, t.ID, util.NowMs()-7*86_400_000).Scan(&sum.WeekAdds, &sum.WeekReduces); err != nil {
		return nil, err
	}
	if have {
		sum.TodayPnl = util.Ptr(util.Fmt(today.RoundBank(2)))
		sum.TotalPnl = util.Ptr(util.Fmt(total.RoundBank(2)))
	}
	return sum, nil
}

func listTasks(ctx context.Context, s *Server, _ []byte) (any, error) {
	rows, err := store.Tasks(ctx, s.E.DB)
	if err != nil {
		return nil, err
	}
	out := []*TaskSummary{}
	for i := range rows {
		sum, err := summarize(ctx, s, &rows[i])
		if err != nil {
			return nil, err
		}
		out = append(out, sum)
	}
	return out, nil
}

type SignalWithOrders struct {
	store.SignalRow
	Orders []store.OrderRow `json:"orders"`
}

type MirrorDto struct {
	store.MirrorRow
	Alias string `json:"alias"`
}

type TaskDetail struct {
	*TaskSummary
	LatencyP95 *int64             `json:"latency_p95"`
	Mirrors    []MirrorDto        `json:"mirrors"`
	Signals    []SignalWithOrders `json:"signals"`
}

// p95 of an ascending-sorted latency list.
func p95(lats []int64) *int64 {
	if len(lats) == 0 {
		return nil
	}
	i := int(math.Ceil(float64(len(lats))*0.95)) - 1
	i = max(0, min(i, len(lats)-1))
	return &lats[i]
}

func int64s(ctx context.Context, s *Server, q string, args ...any) ([]int64, error) {
	rows, err := s.E.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func getTask(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[idArg](body)
	if err != nil {
		return nil, err
	}
	db := s.E.DB
	t, err := store.Task(ctx, db, a.ID)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, errs.Msg("任务不存在")
	}
	sum, err := summarize(ctx, s, t)
	if err != nil {
		return nil, err
	}
	lats, err := int64s(ctx, s, "SELECT latency_ms FROM orders WHERE task_id = ? AND latency_ms IS NOT NULL AND ts > ? ORDER BY latency_ms", a.ID, util.NowMs()-30*86_400_000)
	if err != nil {
		return nil, err
	}
	mrows, err := store.Mirrors(ctx, db, "WHERE task_id = ? AND (status IN ('live','filled','grace','not_mirrored','failed') OR updated_at > ?) ORDER BY created_at DESC LIMIT 200", a.ID, util.NowMs()-3_600_000)
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
	mirrors := []MirrorDto{}
	for _, m := range mrows {
		mirrors = append(mirrors, MirrorDto{MirrorRow: m, Alias: aliases[m.ConnectionID]})
	}
	sigs, err := store.Signals(ctx, db, "WHERE task_id = ? ORDER BY ts DESC LIMIT 50", a.ID)
	if err != nil {
		return nil, err
	}
	signals := []SignalWithOrders{}
	for _, sg := range sigs {
		orders, err := store.Orders(ctx, db, "WHERE signal_id = ? ORDER BY ts", sg.ID)
		if err != nil {
			return nil, err
		}
		if orders == nil {
			orders = []store.OrderRow{}
		}
		signals = append(signals, SignalWithOrders{SignalRow: sg, Orders: orders})
	}
	return TaskDetail{TaskSummary: sum, LatencyP95: p95(lats), Mirrors: mirrors, Signals: signals}, nil
}

// ---------- wizard preview ----------

type PreviewRow struct {
	ConnectionID string  `json:"connection_id"`
	Alias        string  `json:"alias"`
	Equity       string  `json:"equity"`
	Available    string  `json:"available"`
	RatioPct     *string `json:"ratio_pct"`
	SampleTarget *string `json:"sample_target"`
	SyncNotional string  `json:"sync_notional"`
}

type PreviewDto struct {
	SourceEquity    string       `json:"source_equity"`
	SampleBase      *string      `json:"sample_base"`
	SourcePositions int          `json:"source_positions"`
	Rows            []PreviewRow `json:"rows"`
	Warnings        []string     `json:"warnings"`
	SyncNotional    string       `json:"sync_notional"`
	SyncMarginPct   string       `json:"sync_margin_pct"`
}

func previewTask(ctx context.Context, s *Server, body []byte) (any, error) {
	a, err := bind[struct {
		Input struct {
			SourceID  string         `json:"source_id"`
			Followers []FollowerSpec `json:"followers"`
			Rules     engine.Rules   `json:"rules"`
		} `json:"input"`
	}](body)
	if err != nil {
		return nil, err
	}
	in := a.Input
	db := s.E.DB
	srcRow, err := store.Source(ctx, db, in.SourceID)
	if err != nil {
		return nil, err
	}
	if srcRow == nil {
		return nil, errs.Msg("信号源不存在")
	}
	sx, err := s.E.SourceAdapter(ctx, srcRow)
	if err != nil {
		return nil, err
	}
	sm, err := s.E.Markets(ctx, sx)
	if err != nil {
		return nil, err
	}
	src, err := sx.Snapshot(ctx, sm, false)
	if err != nil {
		return nil, err
	}
	var sample *model.Position
	for i := range src.Positions {
		p := &src.Positions[i]
		if sample == nil || p.Size.Mul(p.MarkPx).Abs().GreaterThanOrEqual(sample.Size.Mul(sample.MarkPx).Abs()) {
			sample = p
		}
	}
	rows := []PreviewRow{}
	warnings := []string{}
	warn := func(w string) {
		// Consecutive duplicates collapse (Vec::dedup).
		if n := len(warnings); n > 0 && warnings[n-1] == w {
			return
		}
		warnings = append(warnings, w)
	}
	totalNotional, totalAvail := decimal.Zero, decimal.Zero
	for _, f := range in.Followers {
		c, err := store.Connection(ctx, db, f.ConnectionID)
		if err != nil {
			return nil, err
		}
		if c == nil {
			return nil, errs.Msg("连接不存在")
		}
		ex, err := s.E.Adapter(ctx, f.ConnectionID)
		if err != nil {
			return nil, err
		}
		m, err := s.E.Markets(ctx, ex)
		if err != nil {
			return nil, err
		}
		fs, err := ex.Snapshot(ctx, m, false)
		if err != nil {
			warn(fmt.Sprintf("%s 读取失败：%v", c.Alias, err))
			continue
		}
		sizing := in.Rules.Sizing
		if f.Overrides != nil && f.Overrides.Sizing != nil {
			sizing = *f.Overrides.Sizing
		}
		var ratio *string
		switch {
		case sizing.Mode == engine.EquityRatio && !src.Equity.IsZero():
			ratio = util.Ptr(util.Fmt(fs.Equity.Div(src.Equity).Mul(sizing.K).Mul(util.Hundred).RoundBank(2)))
		case sizing.Mode == engine.FixedMultiple:
			ratio = util.Ptr(util.Fmt(sizing.K.Mul(util.Hundred).RoundBank(2)))
		}
		syncNotional := decimal.Zero
		var sampleTarget *string
		label := ""
		if p, ok := model.ParsePlatform(c.Platform); ok {
			label = p.Label()
		}
		for _, p := range src.Positions {
			if !in.Rules.Allows(p.Base) {
				continue
			}
			spec := m.Base(p.Base)
			if spec == nil {
				warn(fmt.Sprintf("%s 在 %s 无对应合约，该品种对 %s 将跳过。", p.Base, label, c.Alias))
				continue
			}
			sz := in.Rules.Directional(p.Size)
			t := engine.Target(&sizing, engine.SizingInput{SrcSize: sz, SrcEquity: src.Equity, FollowerEquity: fs.Equity, Price: p.MarkPx, SrcOpenSize: sz})
			units := spec.ToUnits(t)
			if sample != nil && sample.Base == p.Base {
				sampleTarget = util.Ptr(util.Fmt(units.Mul(spec.CoinPerUnit)))
				if units.LessThan(util.MaxD(spec.MinQty, spec.QtyStep)) && !t.IsZero() {
					warn(fmt.Sprintf("%s 目标 %s %s 低于最小下单量，会累计后再补。", c.Alias, p.Base, util.Fmt(t.RoundBank(6))))
				}
			}
			syncNotional = syncNotional.Add(units.Mul(spec.CoinPerUnit).Mul(p.MarkPx).Abs())
		}
		totalNotional = totalNotional.Add(syncNotional)
		totalAvail = totalAvail.Add(fs.Available)
		if c.OneWay != nil && !*c.OneWay {
			warn(fmt.Sprintf("%s 为双向持仓模式，需先在连接页切换为单向。", c.Alias))
		}
		rows = append(rows, PreviewRow{ConnectionID: c.ID, Alias: c.Alias, Equity: util.Fmt(fs.Equity.RoundBank(2)), Available: util.Fmt(fs.Available.RoundBank(2)), RatioPct: ratio, SampleTarget: sampleTarget, SyncNotional: util.Fmt(syncNotional.RoundBank(2))})
	}
	out := PreviewDto{
		SourceEquity: util.Fmt(src.Equity.RoundBank(2)), SourcePositions: len(src.Positions), Rows: rows, Warnings: warnings,
		SyncNotional: util.Fmt(totalNotional.RoundBank(2)), SyncMarginPct: "0",
	}
	if sample != nil {
		out.SampleBase = &sample.Base
	}
	if !totalAvail.IsZero() {
		out.SyncMarginPct = util.Fmt(totalNotional.Div(totalAvail).Mul(util.Hundred).RoundBank(1))
	}
	return out, nil
}
