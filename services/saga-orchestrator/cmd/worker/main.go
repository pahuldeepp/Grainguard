// Command worker publishes saga commands and consumes definitive participant results.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	common "greenguard.local/go-common"
	transport "greenguard.local/kafka-transport"
	"greenguard.local/saga-orchestrator/saga"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Getenv); err != nil {
		slog.Error("saga worker stopped", "error", err)
		os.Exit(1)
	}
}

const tenantPage = 100

type config struct {
	url       string
	brokers   []string
	holder    string
	group     string
	ttl       time.Duration
	maxShards int
	metrics   string
}

// loadConfig fails closed. The retired explicit tenant list is rejected so a
// stale deployment cannot silently fall back to unleased static dispatch.
func loadConfig(getenv func(string) string) (config, error) {
	cfg := config{
		url:       getenv("SAGA_DATABASE_URL"),
		brokers:   strings.FieldsFunc(getenv("KAFKA_BROKERS"), func(r rune) bool { return r == ',' || r == ' ' }),
		holder:    strings.TrimSpace(getenv("SAGA_WORKER_ID")),
		group:     strings.TrimSpace(getenv("SAGA_RESULT_GROUP")),
		ttl:       15 * time.Second,
		maxShards: saga.ShardCount,
		metrics:   strings.TrimSpace(getenv("SAGA_METRICS_ADDR")),
	}
	if getenv("SAGA_TENANT_IDS") != "" {
		return config{}, errors.New("SAGA_TENANT_IDS is retired: workers take leased shards (ADR-0013)")
	}
	if (cfg.url == "" && getenv("SHARD_REGISTRY_FILE") == "") || len(cfg.brokers) == 0 {
		return config{}, errors.New("SAGA_DATABASE_URL and KAFKA_BROKERS are required")
	}
	if raw := getenv("SAGA_LEASE_TTL_SECONDS"); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 2 || seconds > 300 {
			return config{}, errors.New("SAGA_LEASE_TTL_SECONDS must be 2..300")
		}
		cfg.ttl = time.Duration(seconds) * time.Second
	}
	if raw := getenv("SAGA_MAX_SHARDS"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > saga.ShardCount {
			return config{}, fmt.Errorf("SAGA_MAX_SHARDS must be 1..%d", saga.ShardCount)
		}
		cfg.maxShards = n
	}
	if cfg.group == "" {
		cfg.group = "greenguard-saga-orchestrator-v1"
	}
	if cfg.holder == "" {
		cfg.holder = defaultHolder()
	}
	return cfg, nil
}

func defaultHolder() string {
	host, _ := os.Hostname()
	var b [6]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%s-%d-%s", host, os.Getpid(), hex.EncodeToString(b[:]))
}

func run(ctx context.Context, getenv func(string) string) error {
	cfg, err := loadConfig(getenv)
	if err != nil {
		return err
	}
	if getenv("SHARD_REGISTRY_FILE") != "" {
		return runSharded(ctx, getenv, cfg)
	}
	pool, err := pgxpool.New(ctx, cfg.url)
	if err != nil {
		return err
	}
	defer pool.Close()
	security, err := transport.SecurityOptions(getenv)
	if err != nil {
		return err
	}
	producerOptions := append([]kgo.Opt{kgo.SeedBrokers(cfg.brokers...), kgo.RequiredAcks(kgo.AllISRAcks()),
		kgo.RecordDeliveryTimeout(15 * time.Second), kgo.ProducerLinger(0)}, security...)
	producer, err := kgo.NewClient(producerOptions...)
	if err != nil {
		return err
	}
	defer producer.Close()
	consumerOptions := append(transport.Options(cfg.brokers, cfg.group,
		[]string{saga.ResultTopic}, kgo.FetchIsolationLevel(kgo.ReadCommitted())), security...)
	consumer, err := kgo.NewClient(consumerOptions...)
	if err != nil {
		return err
	}
	defer consumer.CloseAllowingRebalance()
	leases := &saga.Leases{DB: pool, Holder: cfg.holder, TTL: cfg.ttl, MaxShards: cfg.maxShards}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := leases.Release(releaseCtx); err != nil {
			slog.Warn("saga lease release failed; leases expire by TTL", "error", err)
		}
	}()
	// Results are fenced by Kafka group generations plus the saga row version
	// and token; scanning side effects are fenced by the shard lease.
	workerCtx, cancelWorker := context.WithCancel(ctx)
	defer cancelWorker()
	metrics := &saga.Metrics{}
	results := make(chan error, 2)
	go func() {
		results <- resultConsumer{store: saga.Store{DB: pool}, client: consumer, producer: producer, metrics: metrics}.run(workerCtx)
	}()
	if cfg.metrics != "" {
		stopMetrics := serveMetrics(workerCtx, cfg.metrics, saga.Handler(metrics, pool), results)
		defer stopMetrics()
	}
	w := worker{db: pool, store: saga.Store{DB: pool, Fence: leases}, leases: leases, metrics: metrics, cursors: map[int]string{},
		publish: func(ctx context.Context, key, value []byte) error {
			return transport.Publish(ctx, producer, saga.CommandTopic, key, value, commandHeaders(value))
		}}
	return w.loop(ctx, cfg.ttl, results)
}

type worker struct {
	db      common.TxStarter
	store   saga.Store
	leases  *saga.Leases
	publish saga.PublishCommand
	metrics *saga.Metrics
	cursors map[int]string
}

// commandHeaders copies the command's trace context into Kafka headers.
func commandHeaders(value []byte) map[string]string {
	var c struct {
		TenantID      string `json:"tenant_id"`
		CorrelationID string `json:"correlation_id"`
		Traceparent   string `json:"traceparent"`
	}
	if json.Unmarshal(value, &c) != nil || c.Traceparent == "" {
		return nil
	}
	return map[string]string{"traceparent": c.Traceparent, "correlation_id": c.CorrelationID, "tenant_id": c.TenantID}
}

// serveMetrics exposes /metrics until ctx ends; a listener failure is fatal.
func serveMetrics(ctx context.Context, addr string, handler http.Handler, errs chan<- error) func() {
	mux := http.NewServeMux()
	mux.Handle("/metrics", handler)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- fmt.Errorf("metrics listener: %w", err)
		}
	}()
	return func() {
		shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}
}

func (w worker) loop(ctx context.Context, ttl time.Duration, results <-chan error) error {
	if err := w.renew(ctx); err != nil {
		return err
	}
	renewTicker := time.NewTicker(ttl / 3)
	defer renewTicker.Stop()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	deadlineTicker := time.NewTicker(5 * time.Second)
	defer deadlineTicker.Stop()
	for {
		var err error
		select {
		case <-ctx.Done():
			return nil
		case err = <-results:
			return err
		case <-renewTicker.C:
			err = w.renew(ctx)
		case <-deadlineTicker.C:
			err = w.eachTenant(ctx, func(tenant string) error {
				n, err := w.store.ExpireDue(ctx, tenant, 100)
				w.metrics.DeadlinesExpired.Add(int64(n))
				return err
			})
		case <-ticker.C:
			err = w.eachTenant(ctx, func(tenant string) error { return w.publishTenant(ctx, tenant) })
		}
		if err != nil && ctx.Err() == nil {
			return err
		}
	}
}

func (w worker) renew(ctx context.Context) error {
	before := w.leases.Held()
	held, err := w.leases.Renew(ctx)
	if err != nil {
		return err
	}
	if len(held) != len(before) {
		slog.Info("saga shard leases changed", "holder", w.leases.Holder, "held", len(held))
	}
	return nil
}

func (w worker) publishTenant(ctx context.Context, tenant string) error {
	for i := 0; i < 50; i++ {
		sent, err := w.store.PublishNextCommand(ctx, tenant, w.publish)
		if err != nil || !sent {
			return err
		}
		w.metrics.CommandsPublished.Add(1)
	}
	return nil
}

// eachTenant visits tenants with pending work in leased shards, one bounded
// page at a time. A lost lease skips that shard until the next renewal.
func (w worker) eachTenant(ctx context.Context, fn func(string) error) error {
	for shard := range w.leases.Held() {
		if err := w.eachTenantInShard(ctx, shard, fn); err != nil {
			return err
		}
	}
	return nil
}

func (w worker) eachTenantInShard(ctx context.Context, shard int, fn func(string) error) error {
	after := w.cursors[shard]
	ids, err := saga.TenantsWithWork(ctx, w.db, shard, after, tenantPage)
	if err != nil {
		return err
	}
	lost, err := visit(ids, fn)
	if err != nil {
		return err
	}
	if lost {
		w.metrics.LeaseLost.Add(1)
	}
	if w.cursors != nil {
		if lost || len(ids) < tenantPage {
			w.cursors[shard] = ""
		} else {
			w.cursors[shard] = ids[len(ids)-1]
		}
	}
	return nil
}

func visit(ids []string, fn func(string) error) (bool, error) {
	for _, id := range ids {
		err := fn(id)
		if errors.Is(err, common.ErrTenantQuiescing) {
			continue
		}
		if errors.Is(err, saga.ErrLeaseLost) {
			slog.Warn("saga shard lease lost; side effect refused", "shard", saga.ShardFor(id))
			return true, nil
		} else if err != nil {
			return false, err
		}
	}
	return false, nil
}

// resultConsumer applies participant results. Bounded retry policy: a
// transient (database/transport) failure stops the worker without committing,
// so the offset is retried after restart; a permanent failure is quarantined to
// the result DLQ exactly once, and its offset commits only after the DLQ ack.
type resultConsumer struct {
	store    saga.Store
	client   transport.Client
	producer transport.Client
	metrics  *saga.Metrics
}

func (c resultConsumer) run(ctx context.Context) error {
	for ctx.Err() == nil {
		message, err := transport.NextMessage(ctx, c.client, errors.New("saga result offset lost"))
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if err := c.apply(ctx, message); err != nil {
			return err
		}
		if err := message.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (c resultConsumer) apply(ctx context.Context, message transport.Message) error {
	if _, err := c.store.ApplyResultRecord(ctx, message.Key, message.Value); err != nil {
		if !permanentResultError(err) {
			return err // DB/transport failure: retry this offset after restart
		}
		if err := publishResultDLQ(ctx, c.producer, message, err); err != nil {
			return err // quarantine must be acknowledged before offset commit
		}
		c.metrics.ResultsQuarantined.Add(1)
		return nil
	}
	c.metrics.ResultsApplied.Add(1)
	if result, err := saga.DecodeResult(message.Value, message.Key); err == nil {
		if step, age, err := c.store.CommandAge(ctx, result.TenantID, result.CommandID); err == nil {
			c.metrics.ObserveStepLatency(step, age)
		}
	}
	return nil
}

// consumeResults keeps the original entry point for tests without metrics.
func consumeResults(ctx context.Context, store saga.Store, client, producer transport.Client) error {
	return resultConsumer{store: store, client: client, producer: producer, metrics: &saga.Metrics{}}.run(ctx)
}

func permanentResultError(err error) bool {
	return errors.Is(err, saga.ErrInvalidRequest) || errors.Is(err, saga.ErrStaleResult) ||
		errors.Is(err, saga.ErrResultConflict) || errors.Is(err, saga.ErrSagaNotFound)
}

func publishResultDLQ(ctx context.Context, producer transport.Client, message transport.Message, reason error) error {
	value, err := json.Marshal(struct {
		SourceTopic string `json:"source_topic"`
		Partition   int32  `json:"partition"`
		Offset      int64  `json:"offset"`
		Reason      string `json:"reason"`
		KeyBase64   string `json:"key_base64"`
		ValueBase64 string `json:"value_base64"`
	}{message.Topic, message.Partition, message.Offset, reason.Error(),
		base64.StdEncoding.EncodeToString(message.Key), base64.StdEncoding.EncodeToString(message.Value)})
	if err != nil {
		return err
	}
	return transport.Publish(ctx, producer, saga.ResultDLQTopic,
		[]byte(message.Topic+":"+string(message.Key)), value, nil)
}
