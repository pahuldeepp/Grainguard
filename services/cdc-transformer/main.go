package main

import (
	"context"
	"errors"
	common "greenguard.local/go-common"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const shutdownTimeout = 5 * time.Second

type app struct {
	processor *Processor
	ping      func(context.Context) error
	close     func()
}

var newApp = buildApp
var exit = os.Exit
var runService = run
var listen = net.Listen

func buildApp(getenv func(string) string) (*app, error) {
	var brokers []string
	for _, address := range strings.Split(getenv("KAFKA_BROKERS"), ",") {
		if address = strings.TrimSpace(address); address != "" {
			brokers = append(brokers, address)
		}
	}
	if len(brokers) == 0 {
		return nil, errors.New("KAFKA_BROKERS is required")
	}
	dir := getenv("EVENT_SCHEMA_DIR")
	if dir == "" {
		dir = "../../contracts/events"
	}
	schemaSet, err := loadSchemas(dir)
	if err != nil {
		return nil, err
	}
	provider, err := initTracing(getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	if err != nil {
		return nil, err
	}
	group := getenv("KAFKA_GROUP_ID")
	if group == "" {
		group = "greenguard-cdc-transformer-v1"
	}
	kafka, err := newKafkaWithPrefix(brokers, group, getenv("KAFKA_TOPIC_PREFIX"))
	if err != nil {
		shutdownTracing(provider)
		return nil, err
	}
	processor := &Processor{Source: kafka, Sink: kafka, Schemas: schemaSet, Metrics: newMetrics(), Tracer: provider.Tracer("cdc-transformer"), RetryDelay: time.Second, ProcessTimeout: 20 * time.Second}
	return &app{processor: processor, ping: kafka.Ping, close: func() { kafka.Close(); shutdownTracing(provider) }}, nil
}

func newHandler(a *app) http.Handler {
	return common.HealthHandler(func() bool { return a.processor.Metrics.ready.Load() }, a.ping, a.processor.Metrics.serve)
}

func run(ctx context.Context, getenv func(string) string) error {
	a, err := newApp(getenv)
	if err != nil {
		return err
	}
	defer a.close()
	return common.RunHTTP(ctx, getenv, "127.0.0.1:8081", newHandler(a), listen,
		func(ctx context.Context, server *http.Server, listener net.Listener) error {
			return serve(ctx, a, server, listener)
		})
}

func serve(parent context.Context, a *app, server *http.Server, listener net.Listener) error {
	return common.ServeWorker(parent, server, listener, a.processor.Run, func() { a.processor.Metrics.ready.Store(false) }, nil, shutdownTimeout)
}

func main() { common.RunMain(runService, exit) }
