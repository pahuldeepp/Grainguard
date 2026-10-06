package main

import (
	"context"
	"errors"
	"fmt"
	common "greenguard.local/go-common"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"greenguard.local/cassandra-writer/history"
)

type app struct {
	processor *Processor
	session   *history.Reconnecting
	ping      func(context.Context) error
	close     func()
}

var (
	exit          = os.Exit
	runService    = run
	listen        = net.Listen
	newApp        = buildApp
	openCassandra = func(c history.Config) (history.Conn, error) { return history.Open(c) }
)

func buildApp(getenv func(string) string) (*app, error) {
	brokers := strings.TrimSpace(getenv("KAFKA_BROKERS"))
	if brokers == "" {
		return nil, errors.New("KAFKA_BROKERS is required")
	}
	cfg, err := history.LoadConfig(getenv)
	if err != nil {
		return nil, err
	}
	ttl, err := history.TTL(getenv)
	if err != nil {
		return nil, err
	}
	dir := getenv("EVENT_SCHEMA_DIR")
	if dir == "" {
		dir = "../../contracts/events"
	}
	schema, err := loadSchema(dir)
	if err != nil {
		return nil, err
	}
	provider, err := initTracing(getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	if err != nil {
		return nil, err
	}
	// The session is opened lazily and re-created after outages, so a worker
	// that starts while Cassandra is down waits instead of exiting.
	session := &history.Reconnecting{Open: func() (history.Conn, error) { return openCassandra(cfg) }}
	group := strings.TrimSpace(getenv("KAFKA_GROUP_ID"))
	if group == "" {
		group = consumerGroup
	}
	kafka, err := newKafkaWithPrefix(strings.Split(brokers, ","), group, getenv("KAFKA_TOPIC_PREFIX"))
	if err != nil {
		shutdownTracing(provider)
		return nil, err
	}
	store := &history.Store{Session: session, TTL: ttl}
	p := &Processor{Tracer: provider.Tracer(consumerGroup), Source: kafka, Sink: kafka, Schema: schema, Store: store, Transient: history.Transient, Rejected: history.Rejected, Attempts: 5, RetryDelay: time.Second, ProcessTimeout: 30 * time.Second, Connect: session.Connect}
	return &app{processor: p, session: session,
		ping:  func(ctx context.Context) error { return errors.Join(session.Ping(ctx), kafka.Ping(ctx)) },
		close: func() { kafka.Close(); session.Close(); shutdownTracing(provider) }}, nil
}

func newHandler(a *app) http.Handler {
	return common.HealthHandler(func() bool { return a.processor.Ready.Load() }, a.ping, a.metrics)
}

// metrics carries no tenant or device labels.
func (a *app) metrics(w http.ResponseWriter, _ *http.Request) {
	p := a.processor
	age := math.Inf(1)
	if last := p.LastWritten.Load(); last != 0 {
		age = time.Since(time.Unix(0, last)).Seconds()
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = fmt.Fprintf(w, "history_written_total %d\nhistory_quarantined_total %d\nhistory_retries_total %d\nhistory_pending_records %d\nhistory_lag_records %d\nhistory_last_written_age_seconds %g\n",
		p.Written.Load(), p.Quarantined.Load(), p.Retries.Load(), p.Pending.Load(), p.Lag.Load(), age)
	_, _ = fmt.Fprintf(w, "history_cassandra_degraded %d\nhistory_cassandra_outage_seconds %g\nhistory_cassandra_outages_total %d\nhistory_cassandra_sessions_opened_total %d\n",
		boolGauge(p.Degraded.Load()), p.outageSeconds(), p.Outages.Load(), a.sessionsOpened())
}

func (a *app) sessionsOpened() uint64 {
	if a.session == nil {
		return 0
	}
	return a.session.Reconnects.Load()
}

func boolGauge(v bool) int {
	if v {
		return 1
	}
	return 0
}

func run(ctx context.Context, getenv func(string) string) error {
	a, err := newApp(getenv)
	if err != nil {
		return err
	}
	defer a.close()
	addr := getenv("HTTP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8083"
	}
	listener, err := listen("tcp", addr)
	if err != nil {
		return err
	}
	server := common.HTTPServer(addr, newHandler(a))
	return serve(ctx, a, server, listener)
}

func serve(parent context.Context, a *app, server *http.Server, listener net.Listener) error {
	return common.ServeWorker(parent, server, listener, a.processor.Run, func() { a.processor.Ready.Store(false) }, nil, 5*time.Second)
}

func initTracing(endpoint string) (*sdktrace.TracerProvider, error) {
	options := []sdktrace.TracerProviderOption{
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.1))),
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", consumerGroup))),
	}
	if endpoint != "" {
		if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
			return nil, errors.New("invalid OTLP endpoint")
		}
		exporter := otlptracehttp.NewUnstarted(otlptracehttp.WithEndpointURL(strings.TrimRight(endpoint, "/") + "/v1/traces"))
		options = append(options, sdktrace.WithBatcher(exporter))
	}
	return sdktrace.NewTracerProvider(options...), nil
}

func shutdownTracing(provider *sdktrace.TracerProvider) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = provider.Shutdown(ctx)
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "backfill-read-history" {
		if len(os.Args) != 3 || os.Args[2] != "--confirm" {
			fmt.Fprintln(os.Stderr, "usage: cassandra-writer backfill-read-history --confirm")
			exit(2)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		if err := backfillReadHistory(ctx, os.Getenv); err != nil {
			log.Printf("Cassandra history backfill failed; PostgreSQL history remains authoritative: %v", err)
			exit(1)
		}
		return
	}
	common.RunMain(runService, exit)
}
