package main

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Config is read from the environment by run(ctx, getenv) so tests can inject it.
type Config struct {
	DatabaseURL             string
	RabbitURL               string
	KafkaBrokers            []string
	KafkaGroup              string
	AlertsTopic             string
	HTTPAddr                string
	Workers                 int
	Batch                   int
	ReceiptPrefetch         int
	Policy                  DispatchPolicy
	AuthIssuer              string
	AuthAudience            string
	AuthJWKSURL             string
	CursorHMACKey           string
	MembershipFile          string
	MembershipSource        string
	ControlPlaneURL         string
	ControlLookupToken      string
	AllowInsecureMembership bool
}

func loadConfig(getenv func(string) string) (Config, error) {
	c := Config{
		DatabaseURL:             getenv("JOBS_DATABASE_URL"),
		RabbitURL:               getenv("RABBITMQ_URL"),
		KafkaGroup:              orDefault(getenv("JOBS_KAFKA_GROUP"), "jobs-worker"),
		AlertsTopic:             orDefault(getenv("ALERTS_LIFECYCLE_TOPIC"), "greenguard.alerts.lifecycle.v1"),
		HTTPAddr:                orDefault(getenv("JOBS_HTTP_ADDR"), "127.0.0.1:8095"),
		AuthIssuer:              getenv("AUTH_ISSUER"),
		AuthAudience:            getenv("AUTH_AUDIENCE"),
		AuthJWKSURL:             getenv("AUTH_JWKS_URL"),
		CursorHMACKey:           getenv("JOBS_NOTIFICATION_CURSOR_KEY"),
		MembershipFile:          getenv("AUTH_MEMBERSHIP_FILE"),
		MembershipSource:        orDefault(getenv("AUTH_MEMBERSHIP_SOURCE"), "file"),
		ControlPlaneURL:         getenv("CONTROL_PLANE_URL"),
		ControlLookupToken:      getenv("CONTROL_LOOKUP_TOKEN"),
		AllowInsecureMembership: getenv("AUTH_ALLOW_INSECURE_MEMBERSHIP_LOOKUP") == "true",
	}
	if c.DatabaseURL == "" || c.RabbitURL == "" {
		return c, errors.New("JOBS_DATABASE_URL and RABBITMQ_URL are required")
	}
	if c.MembershipSource != "file" && c.MembershipSource != "control-plane" {
		return c, errors.New("AUTH_MEMBERSHIP_SOURCE must be file or control-plane")
	}
	if c.MembershipSource == "control-plane" && (c.ControlPlaneURL == "" || len(c.ControlLookupToken) < 32) {
		return c, errors.New("control-plane membership requires CONTROL_PLANE_URL and CONTROL_LOOKUP_TOKEN (at least 32 bytes)")
	}
	if raw := getenv("AUTH_ALLOW_INSECURE_MEMBERSHIP_LOOKUP"); raw != "" && raw != "true" && raw != "false" {
		return c, errors.New("AUTH_ALLOW_INSECURE_MEMBERSHIP_LOOKUP must be true or false")
	}
	if c.MembershipSource == "control-plane" {
		u, err := url.Parse(c.ControlPlaneURL)
		if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
			(u.Scheme != "https" && !(u.Scheme == "http" && c.AllowInsecureMembership)) {
			return c, errors.New("CONTROL_PLANE_URL must use HTTPS unless AUTH_ALLOW_INSECURE_MEMBERSHIP_LOOKUP=true")
		}
	}
	if b := getenv("KAFKA_BROKERS"); b != "" {
		c.KafkaBrokers = strings.Split(b, ",")
	}

	var err error
	ints := []struct {
		key  string
		def  int
		dest *int
	}{
		{"JOBS_DISPATCH_WORKERS", 4, &c.Workers},
		{"JOBS_DISPATCH_BATCH", 50, &c.Batch},
		{"JOBS_RECEIPT_PREFETCH", 20, &c.ReceiptPrefetch},
		{"JOBS_MAX_DISPATCH_ATTEMPTS", 8, &c.Policy.MaxAttempts},
	}
	for _, f := range ints {
		if *f.dest, err = positiveInt(getenv(f.key), f.def); err != nil {
			return c, fmt.Errorf("%s: %w", f.key, err)
		}
	}
	c.Policy.BaseBackoff, c.Policy.MaxBackoff, c.Policy.PublishTimeout = time.Second, 5*time.Minute, 5*time.Second
	return c, nil
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func positiveInt(v string, def int) (int, error) {
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return 0, errors.New("must be a positive integer")
	}
	return n, nil
}
