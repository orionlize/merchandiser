package notify

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestConfigDefaultsAndValidate(t *testing.T) {
	var c Config
	if err := json.Unmarshal([]byte(`{"telegram":{"enabled":false}}`), &c); err != nil {
		t.Fatal(err)
	}
	if !c.Events.Error || !c.Events.Risk || c.Events.Trade || c.Daily.At != "08:00" || c.Webhook.Format != "generic" {
		t.Fatalf("defaults %+v", c)
	}
	c.Heartbeat.IntervalSecs = 1
	if err := c.Validate(); err != nil || c.Heartbeat.IntervalSecs != 10 {
		t.Fatalf("validate: %v %d", err, c.Heartbeat.IntervalSecs)
	}
	c.Webhook = Webhook{Enabled: true, Format: "feishu", URL: "ftp://x"}
	if c.Validate() == nil {
		t.Fatal("bad webhook url accepted")
	}
	c.Webhook.URL = "https://open.feishu.cn/hook/x"
	c.Daily.At = "25:00"
	if c.Validate() == nil {
		t.Fatal("bad time accepted")
	}
}

func TestWebhookBodies(t *testing.T) {
	m := Message{Cat: CatRisk, Level: "warn", Title: "止损", Detail: "SOL", Ts: 1}
	for _, f := range Formats {
		b, _ := json.Marshal(webhookBody(f, m))
		if !strings.Contains(string(b), "止损") {
			t.Errorf("%s body %s", f, b)
		}
	}
	b, _ := json.Marshal(webhookBody("dingtalk", m))
	if !strings.Contains(string(b), `"msgtype":"text"`) {
		t.Fatalf("dingtalk %s", b)
	}
	if !strings.HasPrefix(m.Text(), "【风控】止损\nSOL") {
		t.Fatalf("text %q", m.Text())
	}
}

func TestEventFilter(t *testing.T) {
	e := Events{Error: true}
	if !e.wants(CatError) || e.wants(CatRisk) || !e.wants(CatReport) || !e.wants(CatTest) {
		t.Fatal("filter")
	}
}
