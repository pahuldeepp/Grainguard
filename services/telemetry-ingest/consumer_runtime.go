package main

import (
	"context"
	"encoding/json"
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
	group := strings.TrimSpace(getenv("BINDING_KAFKA_GROUP"))
	if group == "" {
		group = bindingGroup
	}
	kafka, err := createBindingKafka(strings.Split(brokers, ","), group)
	if err != nil {
		return nil, err
	}
	feed := &BindingFeed{DB: db, TransportTopic: kafka.topicPrefix + bindingTopic, MaxStale: cfg.BindingFeedMaxStale, Partitions: 6, Now: time.Now}
	consumer := &BindingConsumer{Validate: schemas.Validate, Source: kafka, Sink: kafka, Attempts: 5, RetryDelay: time.Second, Timeout: 20 * time.Second,
		Apply: func(ctx context.Context, body []byte) (BindingOutcome, error) {
			var event struct {
				EventType string `json:"event_type"`
			}
			_ = json.Unmarshal(body, &event)
			if event.EventType == eventCableLayout {
				return ApplyLayoutEvent(ctx, db, body)
			}
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
