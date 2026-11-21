// Package notify pushes engine events (errors, risk triggers, task
// lifecycle, fills) to Telegram and webhooks, sends a daily report and pings
// an external heartbeat URL so an outside monitor notices a dead server.
//
// The config lives in the settings table under "notify". Only the process
// that owns the data directory runs an engine, so only it sends anything.
package notify

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

type Telegram struct {
	Enabled bool   `json:"enabled"`
	Token   string `json:"token"`
	ChatID  string `json:"chat_id"`
}

// Webhook formats: generic JSON, or the text-message body of each chat app's
// incoming-webhook robot.
var Formats = []string{"generic", "feishu", "dingtalk", "wecom", "discord", "slack"}

type Webhook struct {
	Enabled bool   `json:"enabled"`
	Format  string `json:"format"`
	URL     string `json:"url"`
}

// Events selects which categories are pushed.
type Events struct {
	Error     bool `json:"error"`
	Risk      bool `json:"risk"`
	Lifecycle bool `json:"lifecycle"`
	Trade     bool `json:"trade"`
	// Source signals of watch-only tasks.
	Signal bool `json:"signal"`
}

type Daily struct {
	Enabled bool `json:"enabled"`
	// HH:MM in the server's time zone.
	At string `json:"at"`
}

type Heartbeat struct {
	Enabled      bool   `json:"enabled"`
	URL          string `json:"url"`
	IntervalSecs uint32 `json:"interval_secs"`
}

type Config struct {
	Telegram  Telegram  `json:"telegram"`
	Webhook   Webhook   `json:"webhook"`
	Events    Events    `json:"events"`
	Daily     Daily     `json:"daily"`
	Heartbeat Heartbeat `json:"heartbeat"`
}

func Default() Config {
	return Config{
		Webhook:   Webhook{Format: "generic"},
		Events:    Events{Error: true, Risk: true, Lifecycle: true, Signal: true},
		Daily:     Daily{At: "08:00"},
		Heartbeat: Heartbeat{IntervalSecs: 60},
	}
}

func (c *Config) UnmarshalJSON(b []byte) error {
	type plain Config
	p := plain(Default())
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*c = Config(p)
	return nil
}

// Validate normalises and checks a config before it is saved.
func (c *Config) Validate() error {
	c.Telegram.Token = strings.TrimSpace(c.Telegram.Token)
	c.Telegram.ChatID = strings.TrimSpace(c.Telegram.ChatID)
	c.Webhook.URL = strings.TrimSpace(c.Webhook.URL)
	c.Heartbeat.URL = strings.TrimSpace(c.Heartbeat.URL)
	ok := false
	for _, f := range Formats {
		if c.Webhook.Format == f {
			ok = true
		}
	}
	if !ok {
		return errs.Msg("未知的 Webhook 格式")
	}
	if c.Telegram.Enabled && (c.Telegram.Token == "" || c.Telegram.ChatID == "") {
		return errs.Msg("请填写 Telegram Bot Token 与 Chat ID")
	}
	for _, u := range []struct {
		on  bool
		url string
		n   string
	}{{c.Webhook.Enabled, c.Webhook.URL, "Webhook"}, {c.Heartbeat.Enabled, c.Heartbeat.URL, "心跳"}} {
		if u.on && !strings.HasPrefix(u.url, "https://") && !strings.HasPrefix(u.url, "http://") {
			return errs.Msg("%s 地址应以 http:// 或 https:// 开头", u.n)
		}
	}
	if _, _, err := parseHM(c.Daily.At); err != nil {
		return errs.Msg("每日报告时间格式应为 HH:MM")
	}
	c.Heartbeat.IntervalSecs = min(max(c.Heartbeat.IntervalSecs, 10), 3600)
	return nil
}

func parseHM(s string) (int, int, error) {
	h, m, ok := strings.Cut(strings.TrimSpace(s), ":")
	if !ok {
		return 0, 0, fmt.Errorf("bad time")
	}
	hh, err1 := strconv.Atoi(h)
	mm, err2 := strconv.Atoi(m)
	if err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, 0, fmt.Errorf("bad time")
	}
	return hh, mm, nil
}

// ChannelStatus is the outcome of the last delivery on one channel.
type ChannelStatus struct {
	LastAt    *int64  `json:"last_at"`
	LastOk    bool    `json:"last_ok"`
	LastError *string `json:"last_error"`
	LastMs    *int64  `json:"last_ms"`
	LastCode  *int    `json:"last_code"`
}

type Status struct {
	Telegram  ChannelStatus `json:"telegram"`
	Webhook   ChannelStatus `json:"webhook"`
	Heartbeat ChannelStatus `json:"heartbeat"`
	// Date (YYYY-MM-DD) of the last daily report sent.
	DailyLast *string `json:"daily_last"`
}

// Categories of messages; report and test bypass the event filter.
const (
	CatError     = "error"
	CatRisk      = "risk"
	CatLifecycle = "lifecycle"
	CatTrade     = "trade"
	CatSignal    = "signal"
	CatReport    = "report"
	CatTest      = "test"
)

var catLabel = map[string]string{
	CatError: "错误", CatRisk: "风控", CatLifecycle: "任务", CatTrade: "成交", CatSignal: "信号", CatReport: "每日报告", CatTest: "测试",
}

type Message struct {
	Cat    string `json:"category"`
	Level  string `json:"level"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Ts     int64  `json:"ts"`
}

// Text renders a message for chat apps.
func (m Message) Text() string {
	var b strings.Builder
	fmt.Fprintf(&b, "【%s】%s", catLabel[m.Cat], m.Title)
	if m.Detail != "" {
		b.WriteString("\n")
		b.WriteString(m.Detail)
	}
	fmt.Fprintf(&b, "\n— Merchandiser %s", time.UnixMilli(m.Ts).Format("01-02 15:04:05"))
	return b.String()
}

type Service struct {
	db     *sql.DB
	root   context.Context
	client *http.Client

	mu  sync.RWMutex
	cfg Config
	st  Status

	q chan Message
	// Report builds the daily report (title, body); set by the engine.
	Report func(ctx context.Context) (string, string)
	// Holds the channel secrets (nil = kept in the settings row, tests).
	vault Vault
}

// Vault is the encrypted secrets file: the bot token and the webhook and
// heartbeat URLs (which embed their own tokens) are kept there, not in the
// settings table.
type Vault interface {
	Locked() bool
	Get(id string) (model.Credentials, error)
	Put(id string, c model.Credentials) error
}

const vaultID = "__notify"

type channelSecrets struct {
	TelegramToken string `json:"telegram_token,omitempty"`
	WebhookURL    string `json:"webhook_url,omitempty"`
	HeartbeatURL  string `json:"heartbeat_url,omitempty"`
}

func (c *Config) secrets() channelSecrets {
	return channelSecrets{TelegramToken: c.Telegram.Token, WebhookURL: c.Webhook.URL, HeartbeatURL: c.Heartbeat.URL}
}

func (cs channelSecrets) empty() bool { return cs == channelSecrets{} }

// stripped is the config without its secrets (what goes in settings).
func (c Config) stripped() Config {
	c.Telegram.Token, c.Webhook.URL, c.Heartbeat.URL = "", "", ""
	return c
}

func (c Config) with(cs channelSecrets) Config {
	c.Telegram.Token, c.Webhook.URL, c.Heartbeat.URL = cs.TelegramToken, cs.WebhookURL, cs.HeartbeatURL
	return c
}

// AttachVault moves the channel secrets into the vault. Called at boot and
// again after the secrets file is unlocked: secrets saved in plain settings
// by older versions are migrated then.
func (s *Service) AttachVault(v Vault) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.vault = v
	if v == nil || v.Locked() {
		return
	}
	var vs channelSecrets
	if c, err := v.Get(vaultID); err == nil {
		_ = json.Unmarshal([]byte(c.Secret), &vs)
	}
	legacy := s.cfg.secrets()
	if !legacy.empty() {
		if vs.TelegramToken == "" {
			vs.TelegramToken = legacy.TelegramToken
		}
		if vs.WebhookURL == "" {
			vs.WebhookURL = legacy.WebhookURL
		}
		if vs.HeartbeatURL == "" {
			vs.HeartbeatURL = legacy.HeartbeatURL
		}
		b, _ := json.Marshal(vs)
		if err := v.Put(vaultID, model.Credentials{Secret: string(b)}); err != nil {
			slog.Warn("notify secrets migrate", "err", err)
			return
		}
		if b, err := json.Marshal(s.cfg.stripped()); err == nil {
			_ = store.SetSetting(s.root, s.db, settingsKey, string(b))
		}
		slog.Info("notify channel secrets moved to the secrets file")
	}
	s.cfg = s.cfg.with(vs)
}

// SecretsAvailable is false while the vault is locked: channels then have no
// tokens and settings cannot be changed.
func (s *Service) SecretsAvailable() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.vault == nil || !s.vault.Locked()
}

const settingsKey, stateKey = "notify", "notify_state"

func New(root context.Context, db *sql.DB) *Service {
	s := &Service{db: db, root: root, client: &http.Client{Timeout: 10 * time.Second}, cfg: Default(), q: make(chan Message, 256)}
	if v, err := store.GetSetting(root, db, settingsKey); err == nil && v != nil {
		var c Config
		if json.Unmarshal([]byte(*v), &c) == nil {
			s.cfg = c
		}
	}
	if v, err := store.GetSetting(root, db, stateKey); err == nil && v != nil {
		var st struct {
			DailyLast *string `json:"daily_last"`
		}
		if json.Unmarshal([]byte(*v), &st) == nil {
			s.st.DailyLast = st.DailyLast
		}
	}
	go s.worker()
	go s.heartbeatLoop()
	go s.dailyLoop()
	return s
}

func (s *Service) Config() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *Service) Status() Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.st
}

func (s *Service) SetConfig(ctx context.Context, c Config) error {
	if !s.SecretsAvailable() {
		return errs.Msg("密钥库未解锁，暂不能修改通知设置")
	}
	if err := c.Validate(); err != nil {
		return err
	}
	stored := c
	s.mu.RLock()
	v := s.vault
	s.mu.RUnlock()
	if v != nil {
		b, _ := json.Marshal(c.secrets())
		if err := v.Put(vaultID, model.Credentials{Secret: string(b)}); err != nil {
			return err
		}
		stored = c.stripped()
	}
	b, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	if err := store.SetSetting(ctx, s.db, settingsKey, string(b)); err != nil {
		return err
	}
	s.mu.Lock()
	s.cfg = c
	s.mu.Unlock()
	return nil
}

func (e Events) wants(cat string) bool {
	switch cat {
	case CatError:
		return e.Error
	case CatRisk:
		return e.Risk
	case CatLifecycle:
		return e.Lifecycle
	case CatTrade:
		return e.Trade
	case CatSignal:
		return e.Signal
	}
	return true
}

// Notify queues a message if its category is enabled and a channel is on.
// Never blocks: a full queue drops the message. Safe on a nil Service.
func (s *Service) Notify(cat, level, title string, detail *string) {
	if s == nil {
		return
	}
	c := s.Config()
	if !c.Events.wants(cat) || (!c.Telegram.Enabled && !c.Webhook.Enabled) {
		return
	}
	m := Message{Cat: cat, Level: level, Title: title, Ts: util.NowMs()}
	if detail != nil {
		m.Detail = *detail
	}
	select {
	case s.q <- m:
	default:
		slog.Warn("notify queue full; message dropped", "title", title)
	}
}

func (s *Service) worker() {
	for {
		select {
		case <-s.root.Done():
			return
		case m := <-s.q:
			c := s.Config()
			ctx, cancel := context.WithTimeout(s.root, 15*time.Second)
			if c.Telegram.Enabled {
				s.record(&s.st.Telegram, s.timed(func() (int, error) { return 0, sendTelegram(ctx, s.client, c.Telegram, m.Text()) }))
			}
			if c.Webhook.Enabled {
				s.record(&s.st.Webhook, s.timed(func() (int, error) { return sendWebhook(ctx, s.client, c.Webhook, m) }))
			}
			cancel()
		}
	}
}

type outcome struct {
	ms   int64
	code int
	err  error
}

func (s *Service) timed(f func() (int, error)) outcome {
	t0 := time.Now()
	code, err := f()
	return outcome{time.Since(t0).Milliseconds(), code, err}
}

func (s *Service) record(st *ChannelStatus, o outcome) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := util.NowMs()
	st.LastAt, st.LastMs, st.LastOk = &now, &o.ms, o.err == nil
	st.LastError = nil
	if o.err != nil {
		st.LastError = util.Ptr(o.err.Error())
		slog.Warn("notify delivery failed", "err", o.err)
	}
	st.LastCode = nil
	if o.code != 0 {
		st.LastCode = util.Ptr(o.code)
	}
}

// Test sends a test message (or heartbeat) on one channel with the given
// config, synchronously. Returns the latency in ms.
func (s *Service) Test(ctx context.Context, c Config, channel string) (int64, error) {
	m := Message{Cat: CatTest, Level: "ok", Title: "通知测试", Detail: "收到这条消息说明推送渠道配置正确。", Ts: util.NowMs()}
	var o outcome
	switch channel {
	case "telegram":
		if c.Telegram.Token == "" || c.Telegram.ChatID == "" {
			return 0, errs.Msg("请填写 Telegram Bot Token 与 Chat ID")
		}
		o = s.timed(func() (int, error) { return 0, sendTelegram(ctx, s.client, c.Telegram, m.Text()) })
		s.record(&s.st.Telegram, o)
	case "webhook":
		if c.Webhook.URL == "" {
			return 0, errs.Msg("请填写 Webhook 地址")
		}
		o = s.timed(func() (int, error) { return sendWebhook(ctx, s.client, c.Webhook, m) })
		s.record(&s.st.Webhook, o)
	case "heartbeat":
		if c.Heartbeat.URL == "" {
			return 0, errs.Msg("请填写心跳地址")
		}
		o = s.timed(func() (int, error) { return ping(ctx, s.client, c.Heartbeat.URL) })
		s.record(&s.st.Heartbeat, o)
	case "report":
		if s.Report == nil {
			return 0, errs.Msg("报告不可用")
		}
		title, body := s.Report(ctx)
		m = Message{Cat: CatReport, Level: "ok", Title: title, Detail: body, Ts: util.NowMs()}
		if !c.Telegram.Enabled && !c.Webhook.Enabled {
			return 0, errs.Msg("请先开启至少一个推送渠道")
		}
		o = s.timed(func() (int, error) {
			if c.Telegram.Enabled {
				if err := sendTelegram(ctx, s.client, c.Telegram, m.Text()); err != nil {
					return 0, err
				}
			}
			if c.Webhook.Enabled {
				return sendWebhook(ctx, s.client, c.Webhook, m)
			}
			return 0, nil
		})
	default:
		return 0, errs.Msg("未知渠道")
	}
	if o.err != nil {
		return o.ms, errs.Msg("发送失败：%v", o.err)
	}
	return o.ms, nil
}

// ---------- background ----------

func (s *Service) heartbeatLoop() {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	var last time.Time
	for {
		select {
		case <-s.root.Done():
			return
		case <-t.C:
		}
		c := s.Config().Heartbeat
		if !c.Enabled || c.URL == "" || time.Since(last) < time.Duration(max(c.IntervalSecs, 10))*time.Second {
			continue
		}
		last = time.Now()
		ctx, cancel := context.WithTimeout(s.root, 10*time.Second)
		s.record(&s.st.Heartbeat, s.timed(func() (int, error) { return ping(ctx, s.client, c.URL) }))
		cancel()
	}
}

// dailyLoop sends the report once a day at the configured time, catching up
// within two hours after a restart or deploy.
func (s *Service) dailyLoop() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.root.Done():
			return
		case <-t.C:
		}
		c := s.Config()
		if !c.Daily.Enabled || s.Report == nil || (!c.Telegram.Enabled && !c.Webhook.Enabled) {
			continue
		}
		h, m, err := parseHM(c.Daily.At)
		if err != nil {
			continue
		}
		now := time.Now()
		at := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, time.Local)
		today := now.Format("2006-01-02")
		st := s.Status()
		if now.Before(at) || now.Sub(at) > 2*time.Hour || (st.DailyLast != nil && *st.DailyLast == today) {
			continue
		}
		s.mu.Lock()
		s.st.DailyLast = &today
		s.mu.Unlock()
		if b, err := json.Marshal(map[string]string{"daily_last": today}); err == nil {
			_ = store.SetSetting(s.root, s.db, stateKey, string(b))
		}
		ctx, cancel := context.WithTimeout(s.root, 30*time.Second)
		title, body := s.Report(ctx)
		cancel()
		select {
		case s.q <- Message{Cat: CatReport, Level: "ok", Title: title, Detail: body, Ts: util.NowMs()}:
		default:
		}
	}
}

// ---------- transports ----------

func post(ctx context.Context, client *http.Client, url string, body any) (int, []byte, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode, rb, nil
}

func sendTelegram(ctx context.Context, client *http.Client, t Telegram, text string) error {
	url := "https://api.telegram.org/bot" + t.Token + "/sendMessage"
	code, rb, err := post(ctx, client, url, map[string]any{"chat_id": t.ChatID, "text": text, "disable_web_page_preview": true})
	if err != nil {
		// The URL carries the token: never surface it.
		return fmt.Errorf("无法连接 Telegram")
	}
	var r struct {
		Ok          bool   `json:"ok"`
		Description string `json:"description"`
	}
	_ = json.Unmarshal(rb, &r)
	if !r.Ok {
		if r.Description == "" {
			r.Description = fmt.Sprintf("HTTP %d", code)
		}
		return fmt.Errorf("Telegram：%s", r.Description)
	}
	return nil
}

// webhookBody is the request body of a text message for each format.
func webhookBody(format string, m Message) any {
	text := m.Text()
	switch format {
	case "feishu":
		return map[string]any{"msg_type": "text", "content": map[string]string{"text": text}}
	case "dingtalk", "wecom":
		return map[string]any{"msgtype": "text", "text": map[string]string{"content": text}}
	case "discord":
		return map[string]string{"content": text}
	case "slack":
		return map[string]string{"text": text}
	}
	return map[string]any{"category": m.Cat, "level": m.Level, "title": m.Title, "detail": m.Detail, "ts": m.Ts, "text": text}
}

func sendWebhook(ctx context.Context, client *http.Client, w Webhook, m Message) (int, error) {
	code, rb, err := post(ctx, client, w.URL, webhookBody(w.Format, m))
	if err != nil {
		return 0, fmt.Errorf("无法连接 Webhook 地址")
	}
	if code < 200 || code >= 300 {
		return code, fmt.Errorf("HTTP %d", code)
	}
	// Chat robots answer 200 with an error code in the body.
	var r map[string]any
	if json.Unmarshal(rb, &r) == nil {
		for _, k := range []string{"code", "errcode", "StatusCode"} {
			if v, ok := r[k].(float64); ok && v != 0 {
				msg, _ := r["msg"].(string)
				if msg == "" {
					msg, _ = r["errmsg"].(string)
				}
				if msg == "" {
					msg, _ = r["StatusMessage"].(string)
				}
				return code, fmt.Errorf("%s=%v %s", k, v, msg)
			}
		}
	}
	return code, nil
}

func ping(ctx context.Context, client *http.Client, url string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("无法连接心跳地址")
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp.StatusCode, nil
}
