package main

import (
	"strings"
	"testing"
	"time"
)

func cfgEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestConfigDefaultsLeaveTheEndpointDisabled(t *testing.T) {
	cfg, err := loadIngestConfig(cfgEnv(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Auth != nil || cfg.OTLPEndpoint != "" || cfg.SampleRatio != 1 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.Limits != DefaultLimitConfig() {
		t.Fatalf("limits: %+v", cfg.Limits)
	}
	if cfg.Policy.MaxAge != 168*time.Hour || cfg.Policy.MaxFutureSkew != 5*time.Minute {
		t.Fatalf("policy: %+v", cfg.Policy)
	}
}

func TestConfigReadsEveryOverride(t *testing.T) {
	cfg, err := loadIngestConfig(cfgEnv(map[string]string{
		"AUTH_ISSUER": "https://idp.example", "AUTH_AUDIENCE": "greenguard", "AUTH_JWKS_URL": "https://idp.example/jwks",
		"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318", "OTEL_TRACES_SAMPLE_RATIO": "0.25",
		"INGEST_DEVICE_RATE": "2", "INGEST_DEVICE_BURST": "50", "INGEST_TENANT_RATE": "500", "INGEST_TENANT_BURST": "9000",
		"INGEST_MAX_AGE": "24h", "INGEST_MAX_FUTURE_SKEW": "30s",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Auth == nil || cfg.Auth.Issuer != "https://idp.example" || cfg.Auth.Audience != "greenguard" || cfg.Auth.JWKSURL != "https://idp.example/jwks" {
		t.Fatalf("auth: %+v", cfg.Auth)
	}
	if cfg.OTLPEndpoint != "http://collector:4318" || cfg.SampleRatio != 0.25 {
		t.Fatalf("tracing: %q %v", cfg.OTLPEndpoint, cfg.SampleRatio)
	}
	want := LimitConfig{Device: BucketConfig{Rate: 2, Burst: 50}, Tenant: BucketConfig{Rate: 500, Burst: 9000}, MaxEntries: DefaultLimitConfig().MaxEntries}
	if cfg.Limits != want || cfg.Policy.MaxAge != 24*time.Hour || cfg.Policy.MaxFutureSkew != 30*time.Second {
		t.Fatalf("limits/policy: %+v %+v", cfg.Limits, cfg.Policy)
	}
	zero, err := loadIngestConfig(cfgEnv(map[string]string{"OTEL_TRACES_SAMPLE_RATIO": "0"}))
	if err != nil || zero.SampleRatio != 0 {
		t.Fatalf("a sample ratio of exactly 0 is allowed: %v %v", zero.SampleRatio, err)
	}
}

func TestConfigRejectsMistakesWithoutEchoingValues(t *testing.T) {
	auth := map[string]string{"AUTH_ISSUER": "i", "AUTH_AUDIENCE": "a", "AUTH_JWKS_URL": "https://idp.example/jwks"}
	with := func(extra map[string]string) map[string]string {
		merged := map[string]string{}
		for k, v := range auth {
			merged[k] = v
		}
		for k, v := range extra {
			merged[k] = v
		}
		return merged
	}
	cases := map[string]struct {
		env  map[string]string
		want string
	}{
		"only issuer":            {map[string]string{"AUTH_ISSUER": "i"}, "must be set together"},
		"no jwks":                {map[string]string{"AUTH_ISSUER": "i", "AUTH_AUDIENCE": "a"}, "must be set together"},
		"jwks is not a url":      {with(map[string]string{"AUTH_JWKS_URL": "::secret-token"}), "valid URL"},
		"jwks has no host":       {with(map[string]string{"AUTH_JWKS_URL": "https://"}), "valid URL"},
		"jwks over http":         {with(map[string]string{"AUTH_JWKS_URL": "http://idp.example/jwks"}), "must use https"},
		"jwks unusual scheme":    {with(map[string]string{"AUTH_JWKS_URL": "ftp://localhost/jwks"}), "must use https"},
		"otlp not http":          {with(map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "ftp://c"}), "http(s) URL"},
		"otlp unparseable":       {with(map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://[::1"}), "http(s) URL"},
		"otlp no host":           {with(map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://"}), "http(s) URL"},
		"ratio above one":        {with(map[string]string{"OTEL_TRACES_SAMPLE_RATIO": "1.5"}), "OTEL_TRACES_SAMPLE_RATIO"},
		"ratio not a number":     {with(map[string]string{"OTEL_TRACES_SAMPLE_RATIO": "secret"}), "OTEL_TRACES_SAMPLE_RATIO"},
		"device rate zero":       {with(map[string]string{"INGEST_DEVICE_RATE": "0"}), "INGEST_DEVICE_RATE"},
		"device burst negative":  {with(map[string]string{"INGEST_DEVICE_BURST": "-1"}), "INGEST_DEVICE_BURST"},
		"device burst below one": {with(map[string]string{"INGEST_DEVICE_BURST": "0.5"}), "INGEST_DEVICE_BURST"},
		"tenant burst below one": {with(map[string]string{"INGEST_TENANT_BURST": "0.99"}), "INGEST_TENANT_BURST"},
		"tenant rate huge":       {with(map[string]string{"INGEST_TENANT_RATE": "1e12"}), "INGEST_TENANT_RATE"},
		"tenant burst nan":       {with(map[string]string{"INGEST_TENANT_BURST": "NaN"}), "INGEST_TENANT_BURST"},
		"max age not a duration": {with(map[string]string{"INGEST_MAX_AGE": "a week"}), "INGEST_MAX_AGE"},
		"max age zero":           {with(map[string]string{"INGEST_MAX_AGE": "0s"}), "INGEST_MAX_AGE"},
		"future skew negative":   {with(map[string]string{"INGEST_MAX_FUTURE_SKEW": "-5m"}), "INGEST_MAX_FUTURE_SKEW"},
	}
	for name, tc := range cases {
		_, err := loadIngestConfig(cfgEnv(tc.env))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want an error containing %q", name, err, tc.want)
			continue
		}
		if strings.Contains(err.Error(), "secret") {
			t.Errorf("%s: the error leaks the configured value: %v", name, err)
		}
	}
	if _, err := loadIngestConfig(cfgEnv(map[string]string{"AUTH_ISSUER": "i", "AUTH_AUDIENCE": "a", "AUTH_JWKS_URL": "http://localhost:4010/jwks"})); err != nil {
		t.Fatalf("http is allowed for loopback: %v", err)
	}
}

func TestABurstOfExactlyOneIsAccepted(t *testing.T) {
	cfg, err := loadIngestConfig(cfgEnv(map[string]string{"INGEST_DEVICE_BURST": "1", "INGEST_TENANT_BURST": "1"}))
	if err != nil || cfg.Limits.Device.Burst != 1 || cfg.Limits.Tenant.Burst != 1 {
		t.Fatalf("a burst of 1 admits one request at a time: %+v %v", cfg.Limits, err)
	}
}
