// Command cache-invalidator bumps Read API cache versions from committed read-model
// notifications (ADR-0016). It owns no database and never reads raw telemetry.
package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	common "greenguard.local/go-common"
)

const shutdownTimeout = 5 * time.Second

type app struct {
	worker *Worker
	ping   func(context.Context) error
	close  func()
}

var newApp = buildApp
var exit = os.Exit
var runService = run
var listen = net.Listen
var connectRedis = func(getenv func(string) string, timeout time.Duration) (bumperCloser, error) {
	return newRedis(getenv, timeout)
}

type bumperCloser interface {
	Bumper
	Ping(context.Context) error
	Close() error
}

// millis reads a positive duration in milliseconds, or the default when unset.
func millis(getenv func(string) string, key string, fallback int) (time.Duration, error) {
	n, err := positiveInt(getenv, key, fallback)
	return time.Duration(n) * time.Millisecond, err
}

func positiveInt(getenv func(string) string, key string, fallback int) (int, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, errors.New(key + " must be a positive integer")
	}
	return n, nil
}

func loadSettings(getenv func(string) string) (Settings, error) {
	var s Settings
	var errs []error
	collect := func(target *time.Duration, key string, fallback int) {
		value, err := millis(getenv, key, fallback)
		*target, errs = value, append(errs, err)
	}
	collect(&s.Window, "CACHE_INVALIDATION_WINDOW_MS", 25)
	collect(&s.EpochRetry, "CACHE_EPOCH_RETRY_MS", 500)
	collect(&s.OpTimeout, "CACHE_REDIS_TIMEOUT_MS", 100)
	collect(&s.Backoff, "CACHE_REDIS_BACKOFF_MS", 50)
	collect(&s.VersionTTL, "CACHE_VERSION_TTL_MS", 3_600_000)
	var err error
	s.MaxBatch, err = positiveInt(getenv, "CACHE_INVALIDATION_MAX_BATCH", 5000)
	errs = append(errs, err)
	s.Attempts, err = positiveInt(getenv, "CACHE_REDIS_ATTEMPTS", 3)
	errs = append(errs, err)
	s.Concurrency, err = positiveInt(getenv, "CACHE_INVALIDATION_CONCURRENCY", 16)
	errs = append(errs, err)
	s.CommitTimeout = 10 * time.Second
	return s, errors.Join(errs...)
}

func brokers(getenv func(string) string) []string {
	var out []string
	for _, address := range strings.Split(getenv("KAFKA_BROKERS"), ",") {
		if address = strings.TrimSpace(address); address != "" {
			out = append(out, address)
		}
	}
	return out
}

func buildApp(getenv func(string) string) (*app, error) {
	addresses := brokers(getenv)
	if len(addresses) == 0 {
		return nil, errors.New("KAFKA_BROKERS is required")
	}
	settings, err := loadSettings(getenv)
	if err != nil {
		return nil, err
	}
	bumper, err := connectRedis(getenv, settings.OpTimeout)
	if err != nil {
		return nil, err
	}
	group := getenv("KAFKA_GROUP_ID")
	if group == "" {
		group = "cache-invalidator"
	}
	kafka, err := newKafka(addresses, group)
	if err != nil {
		_ = bumper.Close()
		return nil, err
	}
	worker := &Worker{Source: kafka, Bumper: bumper, Metrics: newMetrics(), Settings: settings, Now: time.Now}
	// Readiness follows Kafka only: a Redis outage degrades freshness to the TTL bound,
	// it must not take the consumer out of rotation.
	return &app{worker: worker, ping: kafka.Ping, close: func() { kafka.Close(); _ = bumper.Close() }}, nil
}

func newHandler(a *app) http.Handler {
	return common.HealthHandler(func() bool { return a.worker.Metrics.ready.Load() }, a.ping, a.worker.Metrics.serve)
}

func run(ctx context.Context, getenv func(string) string) error {
	a, err := newApp(getenv)
	if err != nil {
		return err
	}
	defer a.close()
	return common.RunHTTP(ctx, getenv, "127.0.0.1:8091", newHandler(a), listen,
		func(ctx context.Context, server *http.Server, listener net.Listener) error {
			return common.ServeWorker(ctx, server, listener, a.worker.Run, func() { a.worker.Metrics.ready.Store(false) }, nil, shutdownTimeout)
		})
}

func main() { common.RunMain(runService, exit) }
