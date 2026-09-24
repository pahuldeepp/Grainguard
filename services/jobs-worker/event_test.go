package main

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/alert-opened.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func mutate(t *testing.T, fn func(map[string]any)) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(fixture(t), &m); err != nil {
		t.Fatal(err)
	}
	fn(m)
	raw, _ := json.Marshal(m)
	return raw
}

func TestParseFixture(t *testing.T) {
	ev, err := ParseAlertEvent(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := ev.Version(); v != 1 || ev.Payload.Severity != "critical" {
		t.Fatalf("%+v", ev)
	}
}

func TestParseRejectsPoison(t *testing.T) {
	cases := map[string]func(map[string]any){
		"type":   func(m map[string]any) { m["event_type"] = "alert.deleted" },
		"schema": func(m map[string]any) { m["schema_version"] = 2 },
		"tenant": func(m map[string]any) { m["tenant_id"] = "NOT-A-UUID" },
		"mismatch": func(m map[string]any) {
			m["payload"].(map[string]any)["episode_id"] = "a1a1a1a1-0000-4000-8000-000000000009"
		},
		"episode-version": func(m map[string]any) { m["payload"].(map[string]any)["episode_version"] = "2" },
		"version":         func(m map[string]any) { m["aggregate_version"] = "01" },
		"trace":           func(m map[string]any) { m["traceparent"] = "bad" },
		"severity":        func(m map[string]any) { m["payload"].(map[string]any)["severity"] = "CRIT!" },
		"other-severity":  func(m map[string]any) { m["payload"].(map[string]any)["severity"] = "normal" },
		"state":           func(m map[string]any) { m["payload"].(map[string]any)["state"] = "resolved" },
		"unknown-field":   func(m map[string]any) { m["payload"].(map[string]any)["unexpected"] = true },
		"missing-field":   func(m map[string]any) { delete(m["payload"].(map[string]any), "score") },
		"aggregate":       func(m map[string]any) { m["aggregate_type"] = "device" },
	}
	for name, fn := range cases {
		if _, err := ParseAlertEvent(mutate(t, fn)); !errors.Is(err, ErrPoison) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := ParseAlertEvent([]byte("{")); !errors.Is(err, ErrPoison) {
		t.Fatal("broken JSON accepted")
	}
	if _, err := ParseAlertEvent(append(fixture(t), []byte(` {}`)...)); !errors.Is(err, ErrPoison) {
		t.Fatal("trailing JSON accepted")
	}
}

func TestIntentIDIsStableAndDistinct(t *testing.T) {
	a := IntentID("t", "e", 1, "email")
	if a != IntentID("t", "e", 1, "email") {
		t.Fatal("not deterministic")
	}
	for _, other := range []string{IntentID("t", "e", 2, "email"), IntentID("t", "e", 1, "sms"), IntentID("u", "e", 1, "email")} {
		if other == a {
			t.Fatal("collision")
		}
	}
	if !uuidPattern.MatchString(a) || a[14] != '5' {
		t.Fatalf("not a v5 UUID: %s", a)
	}
}

func TestChannelPolicy(t *testing.T) {
	if len(Channels("alert.opened", "critical")) != 3 || len(Channels("alert.escalated", "warning")) != 1 ||
		len(Channels("alert.resolved", "critical")) != 1 || Channels("alert.acknowledged", "critical") != nil {
		t.Fatal("policy changed")
	}
}

func TestBackoffIsExponentialAndCapped(t *testing.T) {
	p := DispatchPolicy{BaseBackoff: time.Second, MaxBackoff: 10 * time.Second}
	got := []time.Duration{p.Backoff(1), p.Backoff(2), p.Backoff(3), p.Backoff(10)}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 10 * time.Second}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("attempt %d: %v", i+1, got[i])
		}
	}
}

func TestConfig(t *testing.T) {
	env := map[string]string{"JOBS_DATABASE_URL": "postgres://x", "RABBITMQ_URL": "amqp://x", "KAFKA_BROKERS": "a:1,b:2", "JOBS_DISPATCH_WORKERS": "7"}
	c, err := loadConfig(func(k string) string { return env[k] })
	if err != nil || c.Workers != 7 || len(c.KafkaBrokers) != 2 || c.AlertsTopic != "greenguard.alerts.lifecycle.v1" || c.Policy.MaxAttempts != 8 {
		t.Fatalf("%+v %v", c, err)
	}
	env["JOBS_DISPATCH_BATCH"] = "0"
	if _, err := loadConfig(func(k string) string { return env[k] }); err == nil {
		t.Fatal("zero batch accepted")
	}
	if _, err := loadConfig(func(string) string { return "" }); err == nil {
		t.Fatal("missing URLs accepted")
	}
}

func TestMetricsHaveNoTenantLabels(t *testing.T) {
	m := &Metrics{}
	m.countDispatch(OutcomePublished)
	m.countDispatch(OutcomeRetry)
	m.countDispatch(OutcomeDead)
	m.countDispatch(OutcomeSkipped)
	m.observeLag([]DueRef{{Available: time.Now().Add(-2 * time.Second)}})
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	body := rec.Body.String()
	if strings.Contains(body, "tenant") || !strings.Contains(body, "jobs_dispatch_published_total 1") || strings.Contains(body, "jobs_dispatch_lag_seconds 0\n") {
		t.Fatal(body)
	}
	m.observeLag(nil)
	if m.lagMillis.Load() != 0 {
		t.Fatal("lag not reset")
	}
}

func TestTruncate(t *testing.T) {
	if truncate("abcdef", 3) != "abc" || truncate("ab", 3) != "ab" {
		t.Fatal("truncate")
	}
	if truncate("éclair", 1) != "" || truncate("éclair", 2) != "é" {
		t.Fatal("truncate split a UTF-8 code point")
	}
}
