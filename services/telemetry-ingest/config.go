package main

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ingestConfig is everything the ingest endpoint needs beyond the database. Auth is nil when
// no AUTH_* setting is present, which leaves the service with its health probes only.
type ingestConfig struct {
	TelemetryV2Enabled  bool
	BindingFeedMaxStale time.Duration
	Auth                *AuthConfig
	OTLPEndpoint        string
	SampleRatio         float64
	Limits              LimitConfig
	Policy              QualityPolicy
	APIKeyEndpoint      string
	APIKeyLookupToken   string
	ControlMeshMTLS     bool
	TrustedProxyCIDRs   []netip.Prefix
}

var loopbackHosts = map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}

func loadIngestConfig(getenv func(string) string) (ingestConfig, error) {
	auth, err := loadAuthConfig(getenv)
	if err != nil {
		return ingestConfig{}, err
	}
	cfg := ingestConfig{Auth: auth, Limits: DefaultLimitConfig(), SampleRatio: 1}
	switch getenv("INGEST_TELEMETRY_V2_ENABLED") {
	case "", "0":
	case "1":
		cfg.TelemetryV2Enabled = true
	default:
		return ingestConfig{}, errors.New("INGEST_TELEMETRY_V2_ENABLED must be 0 or 1")
	}
	cfg.APIKeyEndpoint, cfg.APIKeyLookupToken = getenv("CONTROL_PLANE_URL"), getenv("CONTROL_LOOKUP_TOKEN")
	mesh := getenv("CONTROL_PLANE_MESH_MTLS")
	if mesh != "" && mesh != "true" && mesh != "false" {
		return ingestConfig{}, errors.New("CONTROL_PLANE_MESH_MTLS must be true or false")
	}
	cfg.ControlMeshMTLS = mesh == "true"
	if cfg.TrustedProxyCIDRs, err = loadTrustedProxyCIDRs(getenv("INGEST_TRUSTED_PROXY_CIDRS")); err != nil {
		return ingestConfig{}, err
	}
	if (cfg.APIKeyEndpoint == "") != (cfg.APIKeyLookupToken == "") {
		return ingestConfig{}, errors.New("CONTROL_PLANE_URL and CONTROL_LOOKUP_TOKEN must be set together")
	}
	if cfg.APIKeyEndpoint != "" {
		if _, err := NewAPIKeyVerifierWithMesh(cfg.APIKeyEndpoint, cfg.APIKeyLookupToken, cfg.ControlMeshMTLS); err != nil {
			return ingestConfig{}, err
		}
	}
	if cfg.OTLPEndpoint, err = loadOTLPEndpoint(getenv); err != nil {
		return ingestConfig{}, err
	}
	if cfg.SampleRatio, err = envFloat(getenv, "OTEL_TRACES_SAMPLE_RATIO", 1, 0, 1, true); err != nil {
		return ingestConfig{}, err
	}
	if err = loadLimits(getenv, &cfg.Limits); err != nil {
		return ingestConfig{}, err
	}
	if cfg.Policy.MaxAge, err = envDuration(getenv, "INGEST_MAX_AGE", 168*time.Hour); err != nil {
		return ingestConfig{}, err
	}
	if cfg.Policy.MaxFutureSkew, err = envDuration(getenv, "INGEST_MAX_FUTURE_SKEW", 5*time.Minute); err != nil {
		return ingestConfig{}, err
	}
	cfg.BindingFeedMaxStale, err = loadBindingFeedBound(getenv)
	return cfg, err
}

func loadTrustedProxyCIDRs(raw string) ([]netip.Prefix, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	if len(parts) > 64 {
		return nil, errors.New("INGEST_TRUSTED_PROXY_CIDRS accepts at most 64 CIDR prefixes")
	}
	prefixes := make([]netip.Prefix, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		prefix, err := netip.ParsePrefix(value)
		if err != nil || value == "" {
			return nil, errors.New("INGEST_TRUSTED_PROXY_CIDRS must be a comma-separated list of CIDR prefixes")
		}
		if prefix.Bits() == 0 {
			return nil, errors.New("INGEST_TRUSTED_PROXY_CIDRS must not contain universal CIDRs")
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

// The three AUTH_* settings are all or nothing: a partial set is a deployment mistake and
// must not silently leave the endpoint disabled.
func loadAuthConfig(getenv func(string) string) (*AuthConfig, error) {
	issuer, audience, jwks := getenv("AUTH_ISSUER"), getenv("AUTH_AUDIENCE"), getenv("AUTH_JWKS_URL")
	if issuer == "" && audience == "" && jwks == "" {
		return nil, nil
	}
	if issuer == "" || audience == "" || jwks == "" {
		return nil, errors.New("AUTH_ISSUER, AUTH_AUDIENCE and AUTH_JWKS_URL must be set together")
	}
	u, err := url.Parse(jwks)
	if err != nil || u.Host == "" {
		return nil, errors.New("AUTH_JWKS_URL must be a valid URL")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && loopbackHosts[u.Hostname()]) {
		return nil, errors.New("AUTH_JWKS_URL must use https (http is allowed only for loopback)")
	}
	return &AuthConfig{Issuer: issuer, Audience: audience, JWKSURL: jwks}, nil
}

func loadOTLPEndpoint(getenv func(string) string) (string, error) {
	endpoint := getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		return "", nil
	}
	if u, err := url.Parse(endpoint); err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL")
	}
	return endpoint, nil
}

func loadLimits(getenv func(string) string, limits *LimitConfig) error {
	// A rate must be positive; a burst must allow at least one request, or the bucket could
	// never admit anything.
	targets := []struct {
		key       string
		into      *float64
		low       float64
		inclusive bool
	}{
		{"INGEST_DEVICE_RATE", &limits.Device.Rate, 0, false}, {"INGEST_DEVICE_BURST", &limits.Device.Burst, 1, true},
		{"INGEST_TENANT_RATE", &limits.Tenant.Rate, 0, false}, {"INGEST_TENANT_BURST", &limits.Tenant.Burst, 1, true},
		{"INGEST_KEY_RATE", &limits.Key.Rate, 0, false}, {"INGEST_KEY_BURST", &limits.Key.Burst, 1, true},
	}
	for _, target := range targets {
		value, err := envFloat(getenv, target.key, *target.into, target.low, 1e9, target.inclusive)
		if err != nil {
			return err
		}
		*target.into = value
	}
	return nil
}

// envFloat reads an optional number up to high; the lower bound low is excluded unless lowInclusive.
func envFloat(getenv func(string) string, key string, fallback, low, high float64, lowInclusive bool) (float64, error) {
	raw := getenv(key)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseFloat(raw, 64)
	inRange := err == nil && value <= high && (value > low || (lowInclusive && value == low))
	if !inRange {
		return 0, fmt.Errorf("%s must be a number between %g and %g", key, low, high)
	}
	return value, nil
}

func envDuration(getenv func(string) string, key string, fallback time.Duration) (time.Duration, error) {
	raw := getenv(key)
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration such as 5m", key)
	}
	return value, nil
}

func loadBindingFeedBound(getenv func(string) string) (time.Duration, error) {
	raw := getenv("INGEST_BINDING_FEED_MAX_STALE")
	if raw == "0" {
		return 0, nil
	}
	return envDuration(getenv, "INGEST_BINDING_FEED_MAX_STALE", 5*time.Minute)
}
