package main

import (
	"context"
	"errors"
	"fmt"
	common "greenguard.local/go-common"
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
	ping      func(context.Context) error
	close     func()
}

// cassandra is the production session surface used by buildApp.
type cassandra interface {
	history.Session
	Ping(context.Context) error
	Close()
}

var (
	exit          = os.Exit
	runService    = run
	listen        = net.Listen
	newApp        = buildApp
	openCassandra = func(c history.Config) (cassandra, error) { return history.Open(c) }
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
	session, err := openCassandra(cfg)
	if err != nil {
		shutdownTracing(provider)
		return nil, err
	}
	kafka, err := newKafka(strings.Split(brokers, ","), consumerGroup)
	if err != nil {
		session.Close()
		shutdownTracing(provider)
		return nil, err
	}
	store := &history.Store{Session: session, TTL: ttl}
	p := &Processor{Tracer: provider.Tracer(consumerGroup), Source: kafka, Sink: kafka, Schema: schema, Store: store, Transient: history.Transient, Rejected: history.Rejected, Attempts: 5, RetryDelay: time.Second, ProcessTimeout: 30 * time.Second}
	return &app{processor: p,
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

func main() { common.RunMain(runService, exit) }
