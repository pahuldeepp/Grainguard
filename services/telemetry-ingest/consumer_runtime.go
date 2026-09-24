package main

import (
	"context"
	"errors"
	"strings"
	"time"
)

type bindingRuntime struct {
	done   chan error
	stop   context.CancelFunc
	joined chan struct{}
	kafka  *BindingKafka
}

func (w *bindingRuntime) close() {
	if w.stop != nil {
		w.stop()
		<-w.joined
		w.kafka.Close()
	}
}

var createBindingKafka = newBindingKafka

func startBindingConsumer(parent context.Context, db TxStarter, cfg ingestConfig, getenv func(string) string, app *App) (*bindingRuntime, error) {
	brokers := strings.TrimSpace(getenv("KAFKA_BROKERS"))
	if brokers == "" {
		return &bindingRuntime{}, nil
	}
	dir := getenv("EVENT_SCHEMA_DIR")
	if dir == "" {
		dir = "../../contracts/events"
	}
	schemas, err := loadBindingSchemas(dir)
	if err != nil {
		return nil, err
	}
	kafka, err := createBindingKafka(strings.Split(brokers, ","), bindingGroup)
	if err != nil {
		return nil, err
	}
	feed := &BindingFeed{DB: db, MaxStale: cfg.BindingFeedMaxStale, Partitions: 6, Now: time.Now}
	consumer := &BindingConsumer{Validate: schemas.Validate, Source: kafka, Sink: kafka, Attempts: 5, RetryDelay: time.Second, Timeout: 20 * time.Second,
		Apply: func(ctx context.Context, body []byte) (BindingOutcome, error) {
			return ApplyInventoryEvent(ctx, db, body)
		}, Heartbeat: feed.Heartbeat}
	app.Consumer, app.Feed = consumer, feed
	if app.Ingestor != nil {
		app.Ingestor.feed = feed
	}
	pingDB := app.Ping
	app.Ping = func(ctx context.Context) error { return errors.Join(pingDB(ctx), kafka.Ping(ctx)) }
	ctx, cancel := context.WithCancel(parent)
	worker := &bindingRuntime{done: make(chan error, 1), stop: cancel, joined: make(chan struct{}), kafka: kafka}
	go func() { defer close(worker.joined); worker.done <- consumer.Run(ctx) }()
	return worker, nil
}
