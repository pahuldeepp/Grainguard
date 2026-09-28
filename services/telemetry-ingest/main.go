package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

var (
	newPool           = pgxpool.NewWithConfig
	newApp            = buildApp
	serveHTTP         = (*http.Server).ListenAndServe
	newBindingRuntime = startBindingConsumer
)

func run(ctx context.Context, getenv func(string) string) error {
	if err := common.RequireShardRegistry(getenv); err != nil {
		return err
	}
	url := getenv("TELEMETRY_DATABASE_URL")
	if url == "" && getenv("SHARD_REGISTRY_FILE") == "" {
		return errors.New("TELEMETRY_DATABASE_URL is required")
	}
	cfg, err := loadIngestConfig(getenv)
	if err != nil {
		return err
	}
	var db TxStarter
	var app App
	var shutdownTracing func()
	if getenv("SHARD_REGISTRY_FILE") != "" {
		shards, err := common.ShardedDBFromEnvironment(getenv, "telemetry-ingest", "greenguard_telemetry", "telemetry_app")
		if err != nil {
			return err
		}
		defer shards.Close()
		db = shards
		app, shutdownTracing, err = buildAppWithDB(shards, shards.Ping, nil, cfg)
		if err != nil {
			return err
		}
	} else {
		config, err := pgxpool.ParseConfig(url)
		if err != nil {
			return errors.New("invalid database configuration")
		}
		config.MaxConns = 5
		config.ConnConfig.ConnectTimeout = time.Second
		// PgBouncer transaction pooling cannot keep named prepared statements.
		config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
		pool, err := newPool(context.Background(), config)
		if err != nil {
			return errors.New("database pool initialization failed")
		}
		defer pool.Close()
		app, shutdownTracing, err = newApp(pool, cfg)
		if err != nil {
			return err
		}
		db = pool
	}
	defer shutdownTracing()
	worker, err := newBindingRuntime(ctx, db, cfg, getenv, &app)
	if err != nil {
		return err
	}
	defer worker.close()
	sagaWorker, err := startSagaBindingRuntime(ctx, db, getenv)
	if err != nil {
		return err
	}
	defer sagaWorker.close()
	addr := getenv("HTTP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	server := &http.Server{Addr: addr, Handler: newHandler(app), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	done := make(chan error, 1)
	go func() { done <- serveHTTP(server) }()
	slog.Info("telemetry-ingest listening", "address", addr)
	select {
	case err := <-done:
		return err
	case err := <-worker.done:
		err = bindingWorkerResult(ctx, err)
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return errors.Join(err, server.Shutdown(shutdown))
	case err := <-sagaWorker.done:
		err = bindingWorkerResult(ctx, err)
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return errors.Join(err, server.Shutdown(shutdown))
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}

// buildApp assembles the ingest endpoint when authentication is configured; otherwise the
// service serves only its health probes.
func buildApp(pool *pgxpool.Pool, cfg ingestConfig) (App, func(), error) {
	return buildAppWithDB(pool, pool.Ping, pool, cfg)
}

func buildAppWithDB(db TxStarter, ping func(context.Context) error, pool *pgxpool.Pool, cfg ingestConfig) (App, func(), error) {
	app := App{Ping: ping, DBPool: pool}
	shutdown := func() {
		// Nothing to release: tracing is off.
	}
	if cfg.OTLPEndpoint != "" {
		tracing, err := InitTracing(TracingConfig{ServiceName: serviceName, OTLPEndpoint: cfg.OTLPEndpoint, SampleRatio: cfg.SampleRatio})
		if err != nil {
			return App{}, nil, err
		}
		app.Tracing = tracing
		shutdown = func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = tracing.Shutdown(ctx)
		}
	}
	if cfg.Auth == nil {
		slog.Warn("AUTH_* not set: the ingest endpoint is disabled (health probes only)")
		return app, shutdown, nil
	}
	verifier, err := NewVerifier(*cfg.Auth)
	if err != nil {
		shutdown()
		return App{}, nil, err
	}
	app.Verifier = verifier
	app.PreAuth = NewPreAuthGuard(cfg.TrustedProxyCIDRs...)
	if cfg.APIKeyEndpoint != "" {
		app.APIKeys, err = NewAPIKeyVerifierWithMesh(cfg.APIKeyEndpoint, cfg.APIKeyLookupToken, cfg.ControlMeshMTLS)
		if err != nil {
			shutdown()
			return App{}, nil, err
		}
	}
	app.Metrics = NewMetrics()
	app.Limiter = NewTokenBuckets(cfg.Limits, nil)
	app.Ingestor = NewIngestor(db, cfg.Policy, nil)
	app.Ingestor.v2Enabled = cfg.TelemetryV2Enabled
	app.Ingestor.sensors = resolveLocalSensor
	app.Recorder = NewRejectionRecorder(db, app.Metrics, nil)
	return app, shutdown, nil
}

var exit = os.Exit

func main() {
	if len(os.Args) == 4 && os.Args[1] == "probe" {
		if err := runWorkerProbe(os.Args[2], os.Args[3]); err != nil {
			slog.Error("probe failed", "error", err)
			exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var err error
	if len(os.Args) > 1 && os.Args[1] == "entitlement-projector" {
		err = runEntitlementProjector(ctx, os.Getenv)
	} else {
		err = run(ctx, os.Getenv)
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, context.Canceled) {
		slog.Error("service stopped", "error", err)
		exit(1)
	}
}

func bindingWorkerResult(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return nil
	}
	return err
}
