package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"merchandiser/server/internal/engine"
	"merchandiser/server/internal/notify"
	"merchandiser/server/internal/secrets"
	"merchandiser/server/internal/store"
	"merchandiser/server/internal/totp"
)

func testServer(t *testing.T) (*Server, *secrets.Store) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	sec := secrets.New(dir)
	if err := sec.Unlock("devpass12"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	e := engine.New(ctx, db, sec, engine.NewBus())
	e.Notify = notify.New(ctx, db)
	e.Notify.AttachVault(sec)
	otpState = &otpGuard{tickets: map[string]time.Time{}}
	return &Server{E: e, Token: "tok", Ctx: ctx}, sec
}

type resp struct {
	status int
	body   map[string]any
	grace  string
}

func call(t *testing.T, h http.Handler, cmd, body string, hdr map[string]string) resp {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/"+cmd, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer tok")
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	out := resp{status: w.Code, grace: w.Header().Get("X-OTP-Grace")}
	_ = json.Unmarshal(w.Body.Bytes(), &out.body)
	return out
}

func TestTotpFlowAndAudit(t *testing.T) {
	s, _ := testServer(t)
	h := s.Handler()
	// Off: sensitive commands run without a code.
	if r := call(t, h, "set_lock_password", `{"password":null}`, nil); r.status != 200 {
		t.Fatalf("lock password without 2FA: %+v", r)
	}
	setup := call(t, h, "totp_setup", `{}`, nil)
	secret, _ := setup.body["secret"].(string)
	if secret == "" || !strings.HasPrefix(setup.body["qr_svg"].(string), "<svg") {
		t.Fatalf("setup %+v", setup)
	}
	if r := call(t, h, "totp_enable", `{"code":"000000"}`, nil); r.status != 400 {
		t.Fatalf("wrong enable code accepted: %+v", r)
	}
	code, _ := totp.At(secret, time.Now())
	en := call(t, h, "totp_enable", `{"code":"`+code+`"}`, nil)
	codes, _ := en.body["recovery_codes"].([]any)
	if en.status != 200 || len(codes) != 10 {
		t.Fatalf("enable %+v", en)
	}
	// On: a sensitive command asks for the code.
	r := call(t, h, "set_notify", `{"config":{}}`, nil)
	if r.status != 403 || r.body["code"] != "otp_required" {
		t.Fatalf("no code: %+v", r)
	}
	r = call(t, h, "set_notify", `{"config":{}}`, map[string]string{"X-OTP": "123456"})
	if r.body["code"] != "otp_invalid" {
		t.Fatalf("bad code: %+v", r)
	}
	// The enable code's time step is spent; a recovery code works once.
	rc := codes[0].(string)
	r = call(t, h, "set_notify", `{"config":{}}`, map[string]string{"X-OTP": rc})
	if r.status != 200 || r.grace == "" {
		t.Fatalf("recovery code: %+v", r)
	}
	grace := r.grace
	if r := call(t, h, "set_notify", `{"config":{}}`, map[string]string{"X-OTP": rc}); r.body["code"] != "otp_invalid" {
		t.Fatalf("recovery code reused: %+v", r)
	}
	// The grace ticket skips the prompt, except for commands that need a fresh code.
	if r := call(t, h, "set_notify", `{"config":{}}`, map[string]string{"X-OTP-Grace": grace}); r.status != 200 {
		t.Fatalf("grace: %+v", r)
	}
	if r := call(t, h, "totp_disable", `{}`, map[string]string{"X-OTP-Grace": grace}); r.body["code"] != "otp_required" {
		t.Fatalf("disable with grace only: %+v", r)
	}
	// Five wrong codes lock checking.
	for range 4 {
		call(t, h, "set_notify", `{"config":{}}`, map[string]string{"X-OTP": "000001"})
	}
	if r := call(t, h, "set_notify", `{"config":{}}`, map[string]string{"X-OTP": rc}); r.body["code"] != "otp_locked" {
		t.Fatalf("lockout: %+v", r)
	}
	// Audit: mutating commands only, no secrets.
	rows, err := store.OpLog(context.Background(), s.E.DB, store.OpLogFilter{})
	if err != nil {
		t.Fatal(err)
	}
	var sawFail, sawOtp bool
	for _, row := range rows {
		if row.Command == "totp_status" || row.Command == "get_health" {
			t.Fatalf("read-only command audited: %s", row.Command)
		}
		if row.Summary != nil && strings.Contains(*row.Summary, rc) {
			t.Fatal("recovery code in the audit log")
		}
		if row.Error != nil && strings.Contains(*row.Error, "需要两步验证码") {
			t.Fatal("the code prompt itself was audited")
		}
		sawFail = sawFail || (!row.Ok && row.Sensitive)
		sawOtp = sawOtp || (row.Ok && row.Otp && row.Command == "set_notify")
	}
	if !sawFail || !sawOtp {
		t.Fatalf("audit rows %+v", rows)
	}
	failed, _ := store.OpLog(context.Background(), s.E.DB, store.OpLogFilter{Failed: true, Query: "notify"})
	if len(failed) == 0 {
		t.Fatal("failed filter")
	}
}

// Channel secrets go to the secrets file, never the settings row; plain
// secrets saved by older versions move there on unlock.
func TestNotifySecretsInVault(t *testing.T) {
	s, sec := testServer(t)
	ctx := context.Background()
	h := s.Handler()
	cfg := `{"config":{"telegram":{"enabled":true,"token":"123456:SECRET-TOKEN","chat_id":"42"},"webhook":{"format":"generic"},"daily":{"at":"08:00"}}}`
	if r := call(t, h, "set_notify", cfg, nil); r.status != 200 {
		t.Fatalf("set_notify %+v", r)
	}
	v, _ := store.GetSetting(ctx, s.E.DB, "notify")
	if v == nil || strings.Contains(*v, "SECRET-TOKEN") {
		t.Fatalf("token in settings: %v", v)
	}
	if c, err := sec.Get("__notify"); err != nil || !strings.Contains(c.Secret, "SECRET-TOKEN") {
		t.Fatalf("vault %v %v", c, err)
	}
	if s.E.Notify.Config().Telegram.Token != "123456:SECRET-TOKEN" {
		t.Fatal("service lost the token")
	}
	// Legacy plaintext row.
	_ = store.SetSetting(ctx, s.E.DB, "notify", `{"webhook":{"enabled":true,"format":"generic","url":"https://hooks.example/abc"}}`)
	svc := notify.New(ctx, s.E.DB)
	svc.AttachVault(sec)
	v, _ = store.GetSetting(ctx, s.E.DB, "notify")
	if strings.Contains(*v, "hooks.example") || svc.Config().Webhook.URL != "https://hooks.example/abc" {
		t.Fatalf("legacy migrate: %s / %q", *v, svc.Config().Webhook.URL)
	}
}
