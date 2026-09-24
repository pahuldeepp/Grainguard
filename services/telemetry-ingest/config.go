package main

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

// ingestConfig is everything the ingest endpoint needs beyond the database. Auth is nil when
// no AUTH_* setting is present, which leaves the service with its health probes only.
type ingestConfig struct {
	BindingFeedMaxStale time.Duration
	Auth                *AuthConfig
	OTLPEndpoint        string
	SampleRatio         float64
	Limits              LimitConfig
	Policy              QualityPolicy
}

var loopbackHosts = map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}

func loadIngestConfig(getenv func(string) string) (ingestConfig, error) {
	auth, err := loadAuthConfig(getenv)
	if err != nil {
		return ingestConfig{}, err
	}
	cfg := ingestConfig{Auth: auth, Limits: DefaultLimitConfig(), SampleRatio: 1}
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
