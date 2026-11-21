package api

import (
	"context"
	"net/url"
	"strings"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/notify"
)

// 通知与心跳. Secrets (bot token, webhook and heartbeat URLs) never go back
// to the client: it gets a masked hint, and an empty field on save keeps the
// stored value.

type NotifyHints struct {
	TelegramToken *string `json:"telegram_token"`
	WebhookURL    *string `json:"webhook_url"`
	HeartbeatURL  *string `json:"heartbeat_url"`
}

type NotifyDto struct {
	Config  notify.Config `json:"config"`
	Hints   NotifyHints   `json:"hints"`
	Status  notify.Status `json:"status"`
	Formats []string      `json:"formats"`
	// False while the secrets file is locked (channel tokens unavailable).
	SecretsAvailable bool `json:"secrets_available"`
}

func maskToken(t string) *string {
	if t == "" {
		return nil
	}
	if len(t) <= 10 {
		v := "••••"
		return &v
	}
	v := t[:4] + "…" + t[len(t)-4:]
	return &v
}

func maskURL(raw string) *string {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		v := "••••"
		return &v
	}
	tail := ""
	if p := strings.TrimRight(u.Path, "/"); len(p) > 4 {
		tail = p[len(p)-4:]
	}
	v := u.Scheme + "://" + u.Host + "/…" + tail
	return &v
}

func notifyDto(svc *notify.Service) NotifyDto {
	c := svc.Config()
	d := NotifyDto{Config: c, Status: svc.Status(), Formats: notify.Formats, SecretsAvailable: svc.SecretsAvailable()}
	d.Hints = NotifyHints{TelegramToken: maskToken(c.Telegram.Token), WebhookURL: maskURL(c.Webhook.URL), HeartbeatURL: maskURL(c.Heartbeat.URL)}
	d.Config.Telegram.Token, d.Config.Webhook.URL, d.Config.Heartbeat.URL = "", "", ""
	return d
}

// withSecrets fills empty secret fields from the saved config.
func withSecrets(in notify.Config, saved notify.Config) notify.Config {
	if strings.TrimSpace(in.Telegram.Token) == "" {
		in.Telegram.Token = saved.Telegram.Token
	}
	if strings.TrimSpace(in.Webhook.URL) == "" {
		in.Webhook.URL = saved.Webhook.URL
	}
	if strings.TrimSpace(in.Heartbeat.URL) == "" {
		in.Heartbeat.URL = saved.Heartbeat.URL
	}
	return in
}

func (s *Server) notifier() (*notify.Service, error) {
	if s.E.Notify == nil {
		return nil, errs.Msg("通知服务未启动")
	}
	return s.E.Notify, nil
}

func getNotify(_ context.Context, s *Server, _ []byte) (any, error) {
	svc, err := s.notifier()
	if err != nil {
		return nil, err
	}
	return notifyDto(svc), nil
}

func setNotify(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	svc, err := s.notifier()
	if err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Config notify.Config `json:"config"`
	}](body)
	if err != nil {
		return nil, err
	}
	if err := svc.SetConfig(ctx, withSecrets(a.Config, svc.Config())); err != nil {
		return nil, err
	}
	s.E.Changed("notify")
	return notifyDto(svc), nil
}

func testNotify(ctx context.Context, s *Server, body []byte) (any, error) {
	if err := s.guard(); err != nil {
		return nil, err
	}
	svc, err := s.notifier()
	if err != nil {
		return nil, err
	}
	a, err := bind[struct {
		Channel string        `json:"channel"`
		Config  notify.Config `json:"config"`
	}](body)
	if err != nil {
		return nil, err
	}
	ms, err := svc.Test(ctx, withSecrets(a.Config, svc.Config()), a.Channel)
	s.E.Changed("notify")
	if err != nil {
		return nil, err
	}
	return map[string]int64{"ms": ms}, nil
}
