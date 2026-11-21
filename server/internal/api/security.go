package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/totp"
	"merchandiser/server/internal/util"
)

// 两步验证 (TOTP) for sensitive commands, and the operation audit log.
//
// The TOTP secret and the hashed recovery codes live in the encrypted
// secrets file, like API keys. A sensitive command without a valid code is
// answered with code "otp_required"; the client asks for the code and
// retries with an X-OTP header. A verified code earns a grace ticket
// (X-OTP-Grace) that skips the prompt for 5 minutes.

const (
	totpSecretID  = "__totp"
	totpPendingID = "__totp_pending"
	totpIssuer    = "Merchandiser"
	otpGrace      = 5 * time.Minute
	otpMaxFails   = 5
	otpLockout    = 5 * time.Minute
	recoveryCount = 10
)

// sensitiveCommands need a fresh or recent OTP once 2FA is on. The e-stop
// never does: it must always work.
var sensitiveCommands = map[string]bool{
	"unlock_app":          true,
	"save_connection":     true,
	"delete_connection":   true,
	"close_all_positions": true,
	"delete_task":         true,
	"set_lock_password":   true,
	"set_notify":          true,
	"import_config":       true,
	"totp_disable":        true,
	"totp_recovery_regen": true,
}

// freshOtp commands ignore the grace ticket.
var freshOtp = map[string]bool{"unlock_app": true, "totp_disable": true, "totp_recovery_regen": true}

// readOnlyCommands are not audited.
var readOnlyCommands = map[string]bool{
	"get_health": true, "list_connections": true, "test_connection": true, "validate_connection": true,
	"list_sources": true, "source_detail": true, "plaza_list": true, "plaza_wallet": true, "plaza_simulate": true,
	"list_tasks": true, "get_task": true, "preview_task": true, "task_position_history": true, "task_costs": true,
	"get_notify": true, "get_overview": true, "list_alerts": true, "query_logs": true, "export_logs_csv": true,
	"export_task_audit": true, "pnl_report": true, "equity_series": true, "task_chart": true, "pnl_curve": true,
	"get_settings": true, "symbol_map": true, "symbols_updated_at": true, "totp_status": true, "list_op_log": true,
}

// OtpError carries a machine-readable code for the client's OTP prompt.
type OtpError struct {
	Code string // otp_required | otp_invalid | otp_locked
	Msg  string
}

func (e *OtpError) Error() string { return e.Msg }

type otpGuard struct {
	mu          sync.Mutex
	tickets     map[string]time.Time
	fails       int
	lockedUntil time.Time
	// Last time step accepted: a code is good once.
	lastStep int64
}

var otpState = &otpGuard{tickets: map[string]time.Time{}}

// ---------- request metadata ----------

type reqMeta struct {
	ip, ua      string
	otp, ticket string
	// Set when this request passed the OTP check.
	otpOk bool
	// A grace ticket issued to return to the client.
	newTicket string
}

type metaKey struct{}

func metaOf(ctx context.Context) *reqMeta {
	if m, ok := ctx.Value(metaKey{}).(*reqMeta); ok {
		return m
	}
	return &reqMeta{}
}

func clientIP(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		return strings.TrimSpace(strings.Split(f, ",")[0])
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return h
	}
	return r.RemoteAddr
}

func newMeta(r *http.Request, body []byte) *reqMeta {
	m := &reqMeta{ip: clientIP(r), ua: r.Header.Get("User-Agent"), otp: strings.TrimSpace(r.Header.Get("X-OTP")), ticket: r.Header.Get("X-OTP-Grace")}
	if len(m.ua) > 200 {
		m.ua = m.ua[:200]
	}
	if m.otp == "" {
		var b struct {
			Otp string `json:"otp"`
		}
		if json.Unmarshal(body, &b) == nil {
			m.otp = strings.TrimSpace(b.Otp)
		}
	}
	return m
}

// ---------- TOTP state ----------

type totpData struct {
	Recovery []string `json:"recovery"` // hashes of unused codes
}

func (s *Server) totpEnabled(ctx context.Context) bool {
	v, _ := store.GetSetting(ctx, s.E.DB, "totp_enabled")
	return v != nil && *v == "1"
}

func (s *Server) totpLoad() (secret string, d totpData, err error) {
	c, err := s.E.Secrets.Get(totpSecretID)
	if err != nil {
		return "", d, err
	}
	_ = json.Unmarshal([]byte(c.Secret), &d)
	return c.APIKey, d, nil
}

func (s *Server) totpSave(secret string, d totpData) error {
	b, _ := json.Marshal(d)
	return s.E.Secrets.Put(totpSecretID, model.Credentials{APIKey: secret, Secret: string(b)})
}

// checkOTP verifies the request's code (or grace ticket) for a sensitive
// command. With fresh, only a code counts.
func (s *Server) checkOTP(ctx context.Context, fresh bool) error {
	m := metaOf(ctx)
	if !s.totpEnabled(ctx) {
		return nil
	}
	if s.E.Secrets.Locked() {
		return errs.Msg("密钥库未解锁，无法校验两步验证码")
	}
	g := otpState
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	for t, until := range g.tickets {
		if now.After(until) {
			delete(g.tickets, t)
		}
	}
	if !fresh && m.ticket != "" {
		if until, ok := g.tickets[m.ticket]; ok && now.Before(until) {
			m.otpOk = true
			return nil
		}
	}
	if now.Before(g.lockedUntil) {
		return &OtpError{Code: "otp_locked", Msg: fmt.Sprintf("动态码错误次数过多，请 %d 秒后再试", int(g.lockedUntil.Sub(now).Seconds())+1)}
	}
	if m.otp == "" {
		return &OtpError{Code: "otp_required", Msg: "需要两步验证码"}
	}
	secret, d, err := s.totpLoad()
	if err != nil {
		return err
	}
	ok := false
	if totp.LooksLikeRecovery(m.otp) {
		h := totp.HashRecovery(m.otp)
		for i, x := range d.Recovery {
			if x == h {
				d.Recovery = append(d.Recovery[:i:i], d.Recovery[i+1:]...)
				if err := s.totpSave(secret, d); err != nil {
					return err
				}
				ok = true
				break
			}
		}
	} else if step, good := totp.Verify(secret, m.otp, now); good && step > g.lastStep {
		g.lastStep, ok = step, true
	}
	if !ok {
		g.fails++
		if g.fails >= otpMaxFails {
			g.fails, g.lockedUntil = 0, now.Add(otpLockout)
			return &OtpError{Code: "otp_locked", Msg: "动态码连续错误 5 次，已锁定 5 分钟"}
		}
		return &OtpError{Code: "otp_invalid", Msg: fmt.Sprintf("动态码错误，还可再试 %d 次", otpMaxFails-g.fails)}
	}
	g.fails = 0
	m.otpOk = true
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	m.newTicket = hex.EncodeToString(b)
	g.tickets[m.newTicket] = now.Add(otpGrace)
	return nil
}

// ---------- handlers ----------

type TotpStatus struct {
	Enabled       bool     `json:"enabled"`
	RecoveryLeft  int      `json:"recovery_left"`
	SecretsLocked bool     `json:"secrets_locked"`
	Pending       bool     `json:"pending"`
	Sensitive     []string `json:"sensitive"`
}

func totpStatus(ctx context.Context, s *Server, _ []byte) (any, error) {
	st := TotpStatus{Enabled: s.totpEnabled(ctx), SecretsLocked: s.E.Secrets.Locked(), Sensitive: []string{}}
	for c := range sensitiveCommands {
		st.Sensitive = append(st.Sensitive, c)
	}
	if st.Enabled {
		if _, d, err := s.totpLoad(); err == nil {
			st.RecoveryLeft = len(d.Recovery)
		}
	}
	if _, err := s.E.Secrets.Get(totpPendingID); err == nil {
		st.Pending = true
	}
	return st, nil
}

type TotpSetup struct {
	Secret string `json:"secret"`
	URI    string `json:"uri"`
	// The otpauth URI as an SVG QR code.
	QrSvg string `json:"qr_svg"`
}

func qrSVG(text string) (string, error) {
	q, err := qrcode.New(text, qrcode.Medium)
	if err != nil {
		return "", err
	}
	q.DisableBorder = true
	bm := q.Bitmap()
	n := len(bm)
	var b bytes.Buffer
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 %d %d" shape-rendering="crispEdges"><rect x="-2" y="-2" width="%d" height="%d" fill="#fff"/><path fill="#000" d="`, n+4, n+4, n+4, n+4)
	for y, row := range bm {
		for x, on := range row {
			if on {
				fmt.Fprintf(&b, "M%d %dh1v1h-1z", x, y)
			}
		}
	}
	b.WriteString(`"/></svg>`)
	return b.String(), nil
}

func totpSetup(ctx context.Context, s *Server, _ []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	if s.totpEnabled(ctx) {
		return nil, errs.Msg("两步验证已开启")
	}
	if s.E.Secrets.Locked() {
		return nil, errs.Msg("请先解锁密钥库")
	}
	secret, err := totp.NewSecret()
	if err != nil {
		return nil, err
	}
	if err := s.E.Secrets.Put(totpPendingID, model.Credentials{APIKey: secret}); err != nil {
		return nil, err
	}
	uri := totp.URI(secret, totpIssuer, "merchandiser")
	svg, err := qrSVG(uri)
	if err != nil {
		return nil, err
	}
	return TotpSetup{Secret: secret, URI: uri, QrSvg: svg}, nil
}

func totpEnable(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Code string `json:"code"`
	}](body)
	if err != nil {
		return nil, err
	}
	p, err := s.E.Secrets.Get(totpPendingID)
	if err != nil {
		return nil, errs.Msg("请先生成两步验证密钥")
	}
	step, ok := totp.Verify(p.APIKey, a.Code, time.Now())
	if !ok {
		return nil, errs.Msg("动态码不正确，请确认手机时间准确后重试")
	}
	codes, err := recoveryCodes()
	if err != nil {
		return nil, err
	}
	if err := s.totpSave(p.APIKey, totpData{Recovery: hashAll(codes)}); err != nil {
		return nil, err
	}
	_ = s.E.Secrets.Delete(totpPendingID)
	if err := store.SetSetting(ctx, s.E.DB, "totp_enabled", "1"); err != nil {
		return nil, err
	}
	otpState.mu.Lock()
	otpState.lastStep = max(otpState.lastStep, step)
	otpState.mu.Unlock()
	metaOf(ctx).otpOk = true
	s.E.Changed("security")
	return map[string][]string{"recovery_codes": codes}, nil
}

func totpDisable(ctx context.Context, s *Server, _ []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	if err := s.E.Secrets.Delete(totpSecretID); err != nil {
		return nil, err
	}
	if err := store.SetSetting(ctx, s.E.DB, "totp_enabled", "0"); err != nil {
		return nil, err
	}
	otpState.mu.Lock()
	otpState.tickets = map[string]time.Time{}
	otpState.mu.Unlock()
	s.E.Changed("security")
	return nil, nil
}

func totpRecoveryRegen(ctx context.Context, s *Server, _ []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	secret, _, err := s.totpLoad()
	if err != nil {
		return nil, err
	}
	codes, err := recoveryCodes()
	if err != nil {
		return nil, err
	}
	if err := s.totpSave(secret, totpData{Recovery: hashAll(codes)}); err != nil {
		return nil, err
	}
	s.E.Changed("security")
	return map[string][]string{"recovery_codes": codes}, nil
}

func recoveryCodes() ([]string, error) { return totp.NewRecoveryCodes(recoveryCount) }

func hashAll(codes []string) []string {
	out := make([]string, len(codes))
	for i, c := range codes {
		out[i] = totp.HashRecovery(c)
	}
	return out
}

// ---------- audit log ----------

func listOpLog(ctx context.Context, s *Server, body []byte) (any, error) {
	f, err := bind[store.OpLogFilter](body)
	if err != nil {
		return nil, err
	}
	rows, err := store.OpLog(ctx, s.E.DB, f)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []store.OpLogRow{}
	}
	return rows, nil
}

// auditName is the command as logged: task actions become e.g. "pause_task".
func auditName(cmd string, body []byte) string {
	if cmd != "task_action" {
		return cmd
	}
	var a struct {
		Action string `json:"action"`
	}
	if json.Unmarshal(body, &a) == nil && a.Action != "" {
		return a.Action + "_task"
	}
	return cmd
}

// auditSummary describes a command for the audit log, without secrets.
// It runs before the command, so deleted things can still be named.
func (s *Server) auditSummary(ctx context.Context, cmd string, body []byte) string {
	var b map[string]json.RawMessage
	_ = json.Unmarshal(body, &b)
	str := func(m map[string]json.RawMessage, k string) string {
		var v string
		_ = json.Unmarshal(m[k], &v)
		return v
	}
	obj := func(m map[string]json.RawMessage, k string) map[string]json.RawMessage {
		var v map[string]json.RawMessage
		_ = json.Unmarshal(m[k], &v)
		return v
	}
	db := s.E.DB
	taskName := func(id string) string {
		if t, _ := store.Task(ctx, db, id); t != nil {
			return t.Name
		}
		return id
	}
	connName := func(id string) string {
		if c, _ := store.Connection(ctx, db, id); c != nil {
			if p, ok := model.ParsePlatform(c.Platform); ok {
				return "「" + c.Alias + "」（" + p.Label() + "）"
			}
			return "「" + c.Alias + "」"
		}
		return id
	}
	switch cmd {
	case "task_action", "delete_task", "get_task":
		return taskName(str(b, "id"))
	case "update_task":
		u := obj(b, "update")
		var parts []string
		for _, k := range []struct{ key, label string }{{"name", "名称"}, {"rules", "规则"}, {"risk", "风控"}, {"followers", "跟单账户"}} {
			if _, ok := u[k.key]; ok {
				parts = append(parts, k.label)
			}
		}
		out := taskName(str(b, "id"))
		if len(parts) > 0 {
			out += "：" + strings.Join(parts, "、")
		}
		return out
	case "create_task":
		in := obj(b, "input")
		return str(in, "name")
	case "save_connection":
		in := obj(b, "input")
		label := str(in, "platform")
		if p, ok := model.ParsePlatform(label); ok {
			label = p.Label()
		}
		out := "「" + str(in, "alias") + "」（" + label + "）"
		if str(in, "id") == "" {
			return "新增 " + out
		}
		return out
	case "delete_connection", "switch_one_way":
		return connName(str(b, "id"))
	case "delete_source":
		if src, _ := store.Source(ctx, db, str(b, "id")); src != nil {
			return src.Name
		}
	case "add_source":
		in := obj(b, "input")
		return str(in, "name")
	case "close_all_positions":
		return "全部账户"
	case "plaza_favorite":
		return str(b, "address")
	case "paper_trade":
		in := obj(b, "input")
		return connName(str(in, "connection_id")) + " " + str(in, "action") + " " + str(in, "base")
	case "set_symbol_override":
		return str(b, "base") + " / " + str(b, "platform")
	case "set_lock_password":
		var p struct {
			Password *string `json:"password"`
		}
		_ = json.Unmarshal(body, &p)
		if p.Password == nil || *p.Password == "" {
			return "关闭应用锁"
		}
		return "设置应用锁密码"
	case "unlock_app":
		if s.totpEnabled(ctx) {
			return "密码与动态码"
		}
		return "密码"
	case "set_settings":
		return "通用设置"
	case "set_notify":
		return "通知渠道与事件"
	case "test_notify":
		return str(b, "channel")
	case "totp_setup", "totp_enable", "totp_disable", "totp_recovery_regen":
		return ""
	}
	return redactedKeys(b)
}

var secretKeys = []string{"password", "secret", "token", "key", "otp", "code", "url", "private", "mnemonic"}

// redactedKeys lists a body's top-level fields, hiding secret-looking ones.
func redactedKeys(b map[string]json.RawMessage) string {
	var parts []string
	for k, v := range b {
		lk := strings.ToLower(k)
		hidden := false
		for _, s := range secretKeys {
			if strings.Contains(lk, s) {
				hidden = true
			}
		}
		val := string(v)
		if hidden {
			val = "•••"
		} else if len(val) > 40 || strings.HasPrefix(val, "{") || strings.HasPrefix(val, "[") {
			val = "…"
		}
		parts = append(parts, k+"="+val)
	}
	sort.Strings(parts)
	return strings.Join(parts, " ")
}

// isOtpChallenge reports a sensitive command answered with "enter your code"
// (no code was sent yet).
func isOtpChallenge(err error) bool {
	var oe *OtpError
	return errors.As(err, &oe) && oe.Code == "otp_required"
}

func (s *Server) audit(ctx context.Context, cmd, summary string, body []byte, err error) {
	m := metaOf(ctx)
	row := &store.OpLogRow{Ts: util.NowMs(), Command: auditName(cmd, body), Ok: err == nil, Otp: m.otpOk, Sensitive: sensitiveCommands[cmd]}
	if summary != "" {
		row.Summary = util.Ptr(summary)
	}
	if err != nil {
		row.Error = util.Ptr(err.Error())
	}
	if m.ip != "" {
		row.IP = util.Ptr(m.ip)
	}
	if m.ua != "" {
		row.UA = util.Ptr(m.ua)
	}
	if e := store.InsertOpLog(context.Background(), s.E.DB, row); e != nil {
		return
	}
	s.E.Changed("oplog")
}
