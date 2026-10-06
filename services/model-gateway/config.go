package modelgateway

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type ControlsFile struct {
	RedisCluster           bool              `json:"redis_cluster,omitempty"`
	Admission              AdmissionConfig   `json:"admission"`
	Prices                 map[string]Price  `json:"prices"`
	Attempts               int               `json:"attempts"`
	AttemptTimeoutSeconds  int               `json:"attempt_timeout_seconds"`
	TotalTimeoutSeconds    int               `json:"total_timeout_seconds"`
	BreakerThreshold       int               `json:"breaker_threshold"`
	BreakerCooldownSeconds int               `json:"breaker_cooldown_seconds"`
	Fallbacks              map[string]string `json:"fallbacks"`
}

// OpenControls requires a non-owner, non-superuser runtime and verifies RLS before
// accepting traffic. DSNs come from protected secret files, never CLI arguments.
func OpenControls(ctx context.Context, path, redisURL, postgresDSN string) (*ProductionControls, func(), error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, errors.New("cannot open gateway controls")
	}
	defer f.Close()
	var cfg ControlsFile
	decoder := json.NewDecoder(io.LimitReader(f, 65537))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&cfg) != nil {
		return nil, nil, errors.New("invalid gateway controls file")
	}
	var extra any
	if !errors.Is(decoder.Decode(&extra), io.EOF) {
		return nil, nil, errors.New("invalid gateway controls file")
	}
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, nil, errors.New("invalid Redis configuration")
	}
	if caFile := os.Getenv("MODEL_GATEWAY_REDIS_CA_FILE"); caFile != "" {
		if opts.TLSConfig == nil {
			return nil, nil, errors.New("Redis CA requires verified TLS")
		}
		pem, readErr := os.ReadFile(caFile)
		roots, rootsErr := x509.SystemCertPool()
		if rootsErr != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if readErr != nil || !roots.AppendCertsFromPEM(pem) {
			return nil, nil, errors.New("Redis CA certificate is invalid")
		}
		opts.TLSConfig.RootCAs = roots
		opts.TLSConfig.MinVersion = tls.VersionTLS12
	}
	opts.MaxRetries = -1
	opts.DialTimeout = time.Second
	opts.ReadTimeout = time.Second
	opts.WriteTimeout = time.Second
	opts.ContextTimeoutEnabled = true
	host, _, _ := net.SplitHostPort(opts.Addr)
	if (opts.TLSConfig == nil || opts.TLSConfig.InsecureSkipVerify) && host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return nil, nil, errors.New("Redis TLS required outside loopback")
	}
	var client redis.UniversalClient
	if cfg.RedisCluster {
		client = redis.NewClusterClient(&redis.ClusterOptions{Addrs: []string{opts.Addr}, Username: opts.Username, Password: opts.Password, TLSConfig: opts.TLSConfig, DialTimeout: time.Second, ReadTimeout: time.Second, WriteTimeout: time.Second, MaxRetries: -1, ContextTimeoutEnabled: true})
	} else {
		client = redis.NewClient(opts)
	}
	pool, err := pgxpool.New(ctx, postgresDSN)
	if err != nil {
		client.Close()
		return nil, nil, errors.New("invalid budget configuration")
	}
	connConfig := pool.Config().ConnConfig
	unsafeTLS := !postgresEndpointTLSAllowed(connConfig.Host, connConfig.TLSConfig)
	for _, fallback := range connConfig.Fallbacks {
		unsafeTLS = unsafeTLS || !postgresEndpointTLSAllowed(fallback.Host, fallback.TLSConfig)
	}
	if unsafeTLS {
		pool.Close()
		client.Close()
		return nil, nil, errors.New("Postgres TLS required outside loopback")
	}
	closeAll := func() { pool.Close(); _ = client.Close() }
	var unsafe bool
	err = pool.QueryRow(ctx, `SELECT rolsuper OR rolbypassrls OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('ai_budget_accounts','ai_budget_attempts','ai_usage_outbox','ai_platform_budget') AND pg_has_role(current_user, c.relowner, 'USAGE')) FROM pg_roles WHERE rolname=current_user`).Scan(&unsafe)
	if err != nil || unsafe {
		closeAll()
		return nil, nil, errors.New("budget runtime role must not own tables or bypass RLS")
	}
	var protected int
	err = pool.QueryRow(ctx, `SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('ai_budget_accounts','ai_budget_attempts','ai_usage_outbox') AND relrowsecurity AND relforcerowsecurity`).Scan(&protected)
	if err != nil || protected != 3 || client.Ping(ctx).Err() != nil {
		closeAll()
		return nil, nil, errors.New("gateway dependencies not ready")
	}
	c := &ProductionControls{Admission: &RedisAdmission{Client: client, Config: cfg.Admission}, Budget: &PostgresBudget{Pool: pool}, Prices: cfg.Prices, Attempts: cfg.Attempts, AttemptTimeout: time.Duration(cfg.AttemptTimeoutSeconds) * time.Second, TotalTimeout: time.Duration(cfg.TotalTimeoutSeconds) * time.Second, BreakerThreshold: cfg.BreakerThreshold, BreakerCooldown: time.Duration(cfg.BreakerCooldownSeconds) * time.Second, Fallbacks: cfg.Fallbacks}
	if err = c.validate(); err != nil {
		closeAll()
		return nil, nil, err
	}
	return c, closeAll, nil
}

// Each configured host must independently satisfy the transport policy: a
// loopback primary cannot exempt a remote fallback from verified TLS.
func postgresEndpointTLSAllowed(host string, config *tls.Config) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1" ||
		(config != nil && !config.InsecureSkipVerify)
}
