// Command jobs-worker turns committed alert lifecycle events into a durable notification
// intent ledger and dispatches each intent to RabbitMQ with publisher confirms.
package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
	"greenguard.local/jobs-worker/rabbit"
)

var exit = os.Exit

// component is one long-running loop; run stops all of them when any returns.
type component func(ctx context.Context) error

func openPool(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	// PgBouncer transaction pooling: no server-side prepared statements.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	return pgxpool.NewWithConfig(ctx, cfg)
}

func run(ctx context.Context, getenv func(string) string) error {
	cfg, err := loadConfig(getenv)
	if err != nil {
		return err
	}
	memberships := map[string]apiMembership{}
	if cfg.MembershipSource == "file" {
		memberships, err = loadAPIMemberships(cfg.MembershipFile)
		if err != nil {
			return err
		}
	}
	membershipPath := cfg.MembershipFile
	if cfg.MembershipSource != "file" {
		membershipPath = ""
	}
	authHTTP := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	var db TxStarter
	var healthDB pinger
	var pool *pgxpool.Pool
	if getenv("SHARD_REGISTRY_FILE") != "" {
		shards, err := common.ShardedDBFromEnvironment(getenv, "jobs-worker", "greenguard_jobs", "jobs_app")
		if err != nil {
			return err
		}
		defer shards.Close()
		db, healthDB = shards, shards
	} else {
		pool, err = openPool(ctx, cfg.DatabaseURL)
		if err != nil {
			return err
		}
		defer pool.Close()
		db, healthDB = pool, pool
	}
	metrics := &Metrics{DBPool: pool}
	pub := rabbit.NewPublisher(cfg.RabbitURL, nil)
	defer pub.Close()
	dispatcher := &Dispatcher{DB: db, Pub: pub, Policy: cfg.Policy, Workers: cfg.Workers, Batch: cfg.Batch, Interval: 500 * time.Millisecond, Metrics: metrics}
	parts := []component{dispatcher.Run, receiptLoop(cfg, db, metrics), serveHTTP(cfg.HTTPAddr, metrics, healthDB, &notificationAPI{db: db, issuer: cfg.AuthIssuer, audience: cfg.AuthAudience, jwksURL: cfg.AuthJWKSURL, cursorKey: cfg.CursorHMACKey, client: authHTTP, memberships: memberships, membershipPath: membershipPath, membershipCheckedAt: time.Now(), membershipLastSuccess: time.Now(), membershipSource: cfg.MembershipSource, controlPlaneURL: cfg.ControlPlaneURL, controlLookupToken: cfg.ControlLookupToken, allowInsecureMembership: cfg.AllowInsecureMembership, controlMeshMTLS: cfg.ControlMeshMTLS})}
	if len(cfg.KafkaBrokers) > 0 {
		src, err := newKafkaSource(cfg.KafkaBrokers, cfg.KafkaGroup, cfg.AlertsTopic)
		if err != nil {
			return err
		}
		defer src.Close()
		intake := &Intake{DB: db, Source: src, Metrics: metrics, RetryDelay: time.Second}
		parts = append(parts, intake.Run)
	} else {
		slog.Warn("KAFKA_BROKERS is empty; alert intake is disabled")
	}
	return runAll(ctx, parts)
}

func runAll(ctx context.Context, parts []component) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errs := make([]error, len(parts))
	var wg sync.WaitGroup
	for i, part := range parts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer cancel()
			errs[i] = part(ctx)
		}()
	}
	wg.Wait()
	return errors.Join(errs...)
}

// receiptLoop reconnects the receipt consumer until ctx ends.
func receiptLoop(cfg Config, db TxStarter, m *Metrics) component {
	return func(ctx context.Context) error {
		for ctx.Err() == nil {
			if err := consumeReceipts(ctx, cfg, db, m); err != nil && ctx.Err() == nil {
				slog.Warn("receipt consumer stopped; reconnecting", "error", err)
				select {
				case <-ctx.Done():
				case <-time.After(time.Second):
				}
			}
		}
		return nil
	}
}

func consumeReceipts(ctx context.Context, cfg Config, db TxStarter, m *Metrics) error {
	ch, closer, err := rabbit.Dial(cfg.RabbitURL)
	if err != nil {
		return err
	}
	defer closer()
	return rabbit.Consume(ctx, ch, rabbit.ReceiptQueue, cfg.ReceiptPrefetch, ReceiptHandler(db, m))
}

type pinger interface{ Ping(context.Context) error }

func serveHTTP(addr string, m *Metrics, db pinger, notificationReads *notificationAPI) component {
	return func(ctx context.Context) error {
		if notificationReads == nil {
			notificationReads = &notificationAPI{}
		}
		mux := http.NewServeMux()
		mux.Handle("GET /metrics", m)
		mux.Handle("/internal/v1/notification-intents", notificationReads.handler())
		mux.Handle("GET /readyz/notification-history", notificationReads.readinessHandler(db))
		mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
		mux.HandleFunc("GET /readyz", readyHandler(db))
		srv := &http.Server{Addr: addr, Handler: common.REDMetrics(mux), ReadHeaderTimeout: 5 * time.Second}
		go func() {
			<-ctx.Done()
			sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			_ = srv.Shutdown(sctx)
		}()
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

func readyHandler(db pinger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
		defer cancel()
		if err := db.Ping(pctx); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ready\n"))
	}
}

// dispatch selects the service or an operator subcommand (redrive-dead, dlq-replay).
func dispatch(ctx context.Context, args []string, getenv func(string) string, out io.Writer) error {
	if len(args) > 0 {
		switch args[0] {
		case "redrive-dead":
			return redriveCommand(ctx, args[1:], getenv, out)
		case "dlq-replay":
			return dlqReplayCommand(ctx, args[1:], getenv, out)
		}
	}
	return run(ctx, getenv)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := dispatch(ctx, os.Args[1:], os.Getenv, os.Stdout); err != nil {
		slog.Error("jobs-worker failed", "error", err)
		exit(1)
	}
}
