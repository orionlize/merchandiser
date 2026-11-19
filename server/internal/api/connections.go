package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/exchange"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/secrets"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// ===================== health / global =====================

type HealthDto struct {
	Platforms     []exchange.HealthEntry `json:"platforms"`
	Estopped      bool                   `json:"estopped"`
	Running       int                    `json:"running"`
	Locked        bool                   `json:"locked"`
	SecretBackend string                 `json:"secret_backend"`
	SecretsLocked bool                   `json:"secrets_locked"`
	// Error alerts in the last 5 minutes (tray state).
	RecentErrors int64 `json:"recent_errors"`
}

func getHealth(ctx context.Context, s *Server, _ []byte) (any, error) {
	n, _ := store.Count(ctx, s.E.DB, "SELECT COUNT(*) FROM alerts WHERE level = 'error' AND ts > ?", util.NowMs()-5*60_000)
	return HealthDto{
		Platforms:     exchange.HealthSnapshot(),
		Estopped:      s.E.Estopped(),
		Running:       s.E.RunningCount(),
		Locked:        s.E.Locked(),
		SecretBackend: secrets.Backend,
		SecretsLocked: s.E.Secrets.Locked(),
		RecentErrors:  n,
	}, nil
}

func emergencyStop(ctx context.Context, s *Server, _ []byte) (any, error) {
	return nil, s.E.EmergencyStop(ctx)
}

func releaseEstop(ctx context.Context, s *Server, _ []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	return nil, s.E.ReleaseEstop(ctx)
}

func closeAllPositions(ctx context.Context, s *Server, _ []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	return nil, s.E.CloseEverything(ctx)
}

// ===================== connections =====================

type ConnectionInput struct {
	ID           *string `json:"id"`
	Platform     string  `json:"platform"`
	Alias        string  `json:"alias"`
	Testnet      bool    `json:"testnet"`
	APIKey       string  `json:"api_key"`
	Secret       string  `json:"secret"`
	Proxy        *string `json:"proxy"`
	PaperInitial *string `json:"paper_initial"`
}

func (i *ConnectionInput) creds() model.Credentials {
	return model.Credentials{APIKey: strings.TrimSpace(i.APIKey), Secret: strings.TrimSpace(i.Secret)}
}

type Check struct {
	Level  string  `json:"level"`
	Text   string  `json:"text"`
	Action *string `json:"action"`
}

type ValidationDto struct {
	OK     bool                  `json:"ok"`
	Checks []Check               `json:"checks"`
	Info   *model.ConnectionInfo `json:"info"`
}

func check(level, text string) Check { return Check{Level: level, Text: text} }

func validate(ctx context.Context, s *Server, in *ConnectionInput) ValidationDto {
	checks := []Check{}
	platform, ok := model.ParsePlatform(in.Platform)
	if !ok {
		return ValidationDto{Checks: []Check{check("error", "未知平台")}}
	}
	if strings.TrimSpace(in.Alias) == "" {
		checks = append(checks, check("error", "请填写别名"))
	}
	var creds *model.Credentials
	switch {
	case platform == model.Paper:
	case in.Secret == "" && in.ID != nil:
		// Editing without re-entering secrets: use the stored ones.
		if c, err := s.E.Secrets.Get(*in.ID); err == nil {
			creds = &c
		}
	default:
		c := in.creds()
		creds = &c
	}
	if platform != model.Paper && creds == nil {
		checks = append(checks, check("error", "请填写完整凭证"))
		return ValidationDto{Checks: checks}
	}
	id := "__validate__"
	if in.ID != nil {
		id = *in.ID
	}
	row := &store.ConnectionRow{ID: id, Platform: in.Platform, Alias: in.Alias, Testnet: in.Testnet, Proxy: in.Proxy, PaperInitial: in.PaperInitial}
	ex, err := s.E.BuildAdapter(ctx, row, creds)
	if err != nil {
		checks = append(checks, check("error", err.Error()))
		return ValidationDto{Checks: checks}
	}
	info, err := ex.Info(ctx)
	if err != nil {
		checks = append(checks, check("error", "校验失败："+err.Error()))
		return ValidationDto{Checks: checks}
	}
	skew := info.ClockSkewMs
	if skew < 0 {
		skew = -skew
	}
	lvl := "ok"
	if skew > 1000 {
		lvl = "warn"
	}
	checks = append(checks, check(lvl, fmt.Sprintf("连通正常，延迟 %d ms，时钟偏差 %d ms", info.LatencyMs, info.ClockSkewMs)))
	p := &info.Perms
	if !p.Trade && platform != model.Paper {
		checks = append(checks, check("warn", "权限：只读（可作为信号源，不能作为跟单账户）"))
	} else {
		t := "权限：合约交易"
		if p.Withdraw != nil && !*p.Withdraw {
			t += "，未开启提币"
		}
		if p.Transfer != nil && !*p.Transfer {
			t += "与划转"
		}
		checks = append(checks, check("ok", t))
	}
	if p.Withdraw != nil && *p.Withdraw {
		checks = append(checks, check("error", "该 Key 开启了提币权限。跟单只需合约交易权限，请到交易所关闭提币并绑定 IP 白名单"))
	}
	if p.Note != nil {
		checks = append(checks, check("info", *p.Note))
	}
	if !info.OneWay {
		checks = append(checks, Check{Level: "warn", Text: "持仓模式为双向，跟单账户需切换为单向", Action: util.Ptr("switch_one_way")})
	}
	if in.Testnet {
		checks = append(checks, check("info", "测试网 / 模拟盘连接"))
	}
	okAll := true
	for _, c := range checks {
		if c.Level == "error" {
			okAll = false
		}
	}
	return ValidationDto{OK: okAll, Checks: checks, Info: info}
}

func validateConnection(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Input ConnectionInput `json:"input"`
	}](body)
	if err != nil {
		return nil, err
	}
	return validate(ctx, s, &a.Input), nil
}

func keyHint(p model.Platform, key string) string {
	if p == model.Paper {
		return ""
	}
	k := strings.TrimSpace(key)
	if len(k) <= 8 {
		return "****"
	}
	return k[:4] + "…" + k[len(k)-4:]
}

func emptyToNil(p *string) *string {
	if p == nil || *p == "" {
		return nil
	}
	return p
}

func saveConnection(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Input ConnectionInput `json:"input"`
		Force *bool           `json:"force"`
	}](body)
	if err != nil {
		return nil, err
	}
	in := &a.Input
	v := validate(ctx, s, in)
	// Withdraw permission is a warning the user may override explicitly.
	blocking := false
	var errTexts []string
	for _, c := range v.Checks {
		if c.Level == "error" {
			errTexts = append(errTexts, c.Text)
			if !strings.Contains(c.Text, "提币") {
				blocking = true
			}
		}
	}
	if blocking || (!v.OK && (a.Force == nil || !*a.Force)) {
		return nil, errs.Msg("%s", strings.Join(errTexts, "；"))
	}
	platform, _ := model.ParsePlatform(in.Platform)
	id := util.NewUUID()
	if in.ID != nil {
		id = *in.ID
	}
	if platform != model.Paper && in.Secret != "" {
		if err := s.E.Secrets.Put(id, in.creds()); err != nil {
			return nil, err
		}
	}
	info := model.ConnectionInfo{}
	if v.Info != nil {
		info = *v.Info
	}
	perms, _ := json.Marshal(info.Perms)
	db := s.E.DB
	alias := strings.TrimSpace(in.Alias)
	if in.ID != nil {
		if _, err := db.ExecContext(ctx, "UPDATE connections SET alias=?, testnet=?, proxy=?, perms_json=?, one_way=?, margin_mode=? WHERE id=?",
			alias, in.Testnet, emptyToNil(in.Proxy), string(perms), info.OneWay, info.MarginMode, id); err != nil {
			return nil, uniqueErr(err)
		}
		if in.APIKey != "" {
			if _, err := db.ExecContext(ctx, "UPDATE connections SET key_hint=? WHERE id=?", keyHint(platform, in.APIKey), id); err != nil {
				return nil, err
			}
		}
	} else {
		paperInit := in.PaperInitial
		if paperInit == nil && platform == model.Paper {
			paperInit = util.Ptr("10000")
		}
		if _, err := db.ExecContext(ctx, "INSERT INTO connections (id, platform, alias, testnet, key_hint, proxy, perms_json, one_way, margin_mode, paper_initial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
			id, string(platform), alias, in.Testnet, keyHint(platform, in.APIKey), emptyToNil(in.Proxy), string(perms), info.OneWay, info.MarginMode, paperInit, util.NowMs()); err != nil {
			return nil, uniqueErr(err)
		}
	}
	s.E.ForgetAdapter(id)
	if ex, err := s.E.Adapter(ctx, id); err == nil {
		if m, err := s.E.Markets(ctx, ex); err == nil {
			if snap, err := ex.Snapshot(ctx, m, false); err == nil {
				s.E.RememberSnapshot(id, snap)
				_ = store.InsertEquity(ctx, db, id, snap.Equity, snap.Available, snap.Upnl(), snap.Notional())
			}
		}
	}
	s.E.Changed("connections")
	return id, nil
}

func uniqueErr(err error) error {
	if strings.Contains(err.Error(), "UNIQUE") {
		return errs.Msg("别名已存在")
	}
	return err
}

type ConnectionDto struct {
	ID          string             `json:"id"`
	Platform    string             `json:"platform"`
	Alias       string             `json:"alias"`
	Testnet     bool               `json:"testnet"`
	KeyHint     string             `json:"key_hint"`
	Proxy       *string            `json:"proxy"`
	Perms       *model.Permissions `json:"perms"`
	OneWay      *bool              `json:"one_way"`
	MarginMode  *string            `json:"margin_mode"`
	Equity      *string            `json:"equity"`
	Available   *string            `json:"available"`
	Upnl        *string            `json:"upnl"`
	TodayPnl    *string            `json:"today_pnl"`
	EquityTs    *int64             `json:"equity_ts"`
	LatencyMs   *uint64            `json:"latency_ms"`
	SourceCount int64              `json:"source_count"`
	TaskCount   int64              `json:"task_count"`
}

func parsePerms(j *string) *model.Permissions {
	if j == nil {
		return nil
	}
	var p model.Permissions
	if json.Unmarshal([]byte(*j), &p) != nil {
		return nil
	}
	return &p
}

func listConnections(ctx context.Context, s *Server, _ []byte) (any, error) {
	db := s.E.DB
	day := util.StartOfTodayMs()
	conns, err := store.Connections(ctx, db)
	if err != nil {
		return nil, err
	}
	out := []ConnectionDto{}
	for _, c := range conns {
		latest, first, err := store.EquityBounds(ctx, db, c.ID, day)
		if err != nil {
			return nil, err
		}
		sc, err := store.Count(ctx, db, "SELECT COUNT(*) FROM sources WHERE connection_id = ?", c.ID)
		if err != nil {
			return nil, err
		}
		tc, err := store.Count(ctx, db, "SELECT COUNT(*) FROM task_followers tf JOIN tasks t ON t.id = tf.task_id WHERE tf.connection_id = ? AND t.status != 'stopped'", c.ID)
		if err != nil {
			return nil, err
		}
		d := ConnectionDto{
			ID: c.ID, Platform: c.Platform, Alias: c.Alias, Testnet: c.Testnet, KeyHint: c.KeyHint, Proxy: c.Proxy,
			Perms: parsePerms(c.PermsJSON), OneWay: c.OneWay, MarginMode: c.MarginMode, SourceCount: sc, TaskCount: tc,
		}
		if latest != nil {
			d.Equity, d.Available, d.Upnl, d.EquityTs = &latest.Equity, &latest.Available, &latest.Upnl, &latest.Ts
			if first != nil {
				d.TodayPnl = util.Ptr(util.Fmt(util.Dec(latest.Equity).Sub(util.Dec(*first)).RoundBank(2)))
			}
		}
		if p, ok := model.ParsePlatform(c.Platform); ok {
			d.LatencyMs = exchange.HealthLatency(p)
		}
		out = append(out, d)
	}
	return out, nil
}

type idArg struct {
	ID string `json:"id"`
}

func testConnection(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[idArg](body)
	if err != nil {
		return nil, err
	}
	row, err := store.Connection(ctx, s.E.DB, a.ID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, errs.Msg("连接不存在")
	}
	in := ConnectionInput{ID: &a.ID, Platform: row.Platform, Alias: row.Alias, Testnet: row.Testnet, Proxy: row.Proxy, PaperInitial: row.PaperInitial}
	v := validate(ctx, s, &in)
	if info := v.Info; info != nil {
		perms, _ := json.Marshal(info.Perms)
		if _, err := s.E.DB.ExecContext(ctx, "UPDATE connections SET perms_json=?, one_way=?, margin_mode=? WHERE id=?", string(perms), info.OneWay, info.MarginMode, a.ID); err != nil {
			return nil, err
		}
		_ = store.InsertEquity(ctx, s.E.DB, a.ID, info.Equity, info.Available, decimal.Zero, decimal.Zero)
	}
	s.E.Changed("connections")
	return v, nil
}

func switchOneWay(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		ID    *string          `json:"id"`
		Input *ConnectionInput `json:"input"`
	}](body)
	if err != nil {
		return nil, err
	}
	var ex exchange.Exchange
	switch {
	case a.ID != nil:
		ex, err = s.E.Adapter(ctx, *a.ID)
	case a.Input != nil:
		i := a.Input
		row := &store.ConnectionRow{ID: "__tmp__", Platform: i.Platform, Alias: i.Alias, Testnet: i.Testnet, Proxy: i.Proxy}
		c := i.creds()
		ex, err = s.E.BuildAdapter(ctx, row, &c)
	default:
		return nil, errs.Msg("缺少参数")
	}
	if err != nil {
		return nil, err
	}
	return nil, ex.SetOneWay(ctx)
}

func deleteConnection(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[idArg](body)
	if err != nil {
		return nil, err
	}
	db := s.E.DB
	n, err := store.Count(ctx, db, "SELECT COUNT(*) FROM task_followers tf JOIN tasks t ON t.id = tf.task_id WHERE tf.connection_id = ? AND t.status != 'stopped'", a.ID)
	if err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, errs.Msg("该连接仍被未停止的任务使用")
	}
	if n, err = store.Count(ctx, db, "SELECT COUNT(*) FROM sources WHERE connection_id = ?", a.ID); err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, errs.Msg("该连接被信号源使用，请先删除信号源")
	}
	for _, q := range []string{"DELETE FROM task_followers WHERE connection_id = ?", "DELETE FROM connections WHERE id = ?", "DELETE FROM paper_state WHERE connection_id = ?"} {
		if _, err := db.ExecContext(ctx, q, a.ID); err != nil {
			return nil, err
		}
	}
	if err := s.E.Secrets.Delete(a.ID); err != nil {
		return nil, err
	}
	s.E.ForgetAdapter(a.ID)
	s.E.Changed("connections")
	return nil, nil
}

// ===================== paper manual trading =====================

func paperTrade(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Input struct {
			ConnectionID string  `json:"connection_id"`
			Base         string  `json:"base"`
			Action       string  `json:"action"`
			Buy          bool    `json:"buy"`
			Notional     *string `json:"notional"`
			Price        *string `json:"price"`
			Leverage     *uint32 `json:"leverage"`
			OrderID      *string `json:"order_id"`
		} `json:"input"`
	}](body)
	if err != nil {
		return nil, err
	}
	in := a.Input
	c, err := store.Connection(ctx, s.E.DB, in.ConnectionID)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, errs.Msg("连接不存在")
	}
	if c.Platform != "paper" {
		return nil, errs.Msg("只有模拟账户可以手动下单")
	}
	ex, err := s.E.Adapter(ctx, in.ConnectionID)
	if err != nil {
		return nil, err
	}
	m, err := s.E.Markets(ctx, ex)
	if err != nil {
		return nil, err
	}
	base := strings.ToUpper(strings.TrimSpace(in.Base))
	spec := m.Base(base)
	if spec == nil {
		return nil, errs.Msg("没有 %s 合约", base)
	}
	switch in.Action {
	case "open":
		notional := util.DecP(in.Notional)
		if !notional.IsPositive() {
			return nil, errs.Msg("请填写下单金额")
		}
		var limit *decimal.Decimal
		if p := util.DecP(in.Price); p.IsPositive() {
			limit = &p
		}
		bid, ask, err := ex.BBO(ctx, spec)
		if err != nil {
			return nil, err
		}
		ref := bid
		if in.Buy {
			ref = ask
		}
		if limit != nil {
			ref = *limit
		}
		if !ref.IsPositive() {
			return nil, errs.Msg("无法获取价格")
		}
		ot := model.OrderType{Kind: model.OrderMarket}
		if limit != nil {
			ot = model.OrderType{Kind: model.OrderLimit, Price: *limit}
		}
		req := model.OrderRequest{Buy: in.Buy, Qty: notional.Div(ref), Type: ot, ClientID: util.NewClientID(), RefPx: ref}
		if _, err := ex.Place(ctx, spec, &req); err != nil {
			return nil, err
		}
		if in.Leverage != nil {
			if err := ex.SetLeverage(ctx, spec, min(max(*in.Leverage, 1), 100)); err != nil {
				return nil, err
			}
		}
	case "close":
		snap, err := ex.Snapshot(ctx, m, false)
		if err != nil {
			return nil, err
		}
		var pos *model.Position
		for i := range snap.Positions {
			if snap.Positions[i].Base == base {
				pos = &snap.Positions[i]
				break
			}
		}
		if pos == nil {
			return nil, errs.Msg("没有该持仓")
		}
		req := model.OrderRequest{Buy: pos.Size.IsNegative(), Qty: pos.Size.Abs(), Type: model.OrderType{Kind: model.OrderMarket}, ReduceOnly: true, ClientID: util.NewClientID(), RefPx: pos.MarkPx}
		if _, err := ex.Place(ctx, spec, &req); err != nil {
			return nil, err
		}
	case "cancel":
		if in.OrderID == nil {
			return nil, errs.Msg("缺少订单号")
		}
		if err := ex.Cancel(ctx, spec, *in.OrderID); err != nil {
			return nil, err
		}
	default:
		return nil, errs.Msg("未知操作")
	}
	if snap, err := ex.Snapshot(ctx, m, false); err == nil {
		s.E.RememberSnapshot(in.ConnectionID, snap)
	}
	s.E.Changed("connections")
	s.E.Changed("sources")
	return nil, nil
}
