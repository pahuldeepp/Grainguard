package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// TestKafkaAlertIntakeLive proves the canonical alert event reaches the durable
// intent ledger through the real Kafka consumer, including a replayed event.
func TestKafkaAlertIntakeLive(t *testing.T) {
	if os.Getenv("JOBS_KAFKA_LIVE") != "1" {
		t.Skip("set JOBS_KAFKA_LIVE=1 with Kafka and jobs Postgres running")
	}
	brokers := strings.Split(envOrSkip(t, "KAFKA_BROKERS"), ",")
	db := dbPool(t)
	topic := "greenguard.alerts.lifecycle.v1"
	if v := os.Getenv("ALERTS_LIFECYCLE_TOPIC"); v != "" {
		topic = v
	}
	tenant := randomUUID()
	var event map[string]any
	if err := json.Unmarshal(fixture(t), &event); err != nil {
		t.Fatal(err)
	}
	episode := randomUUID()
	event["tenant_id"] = tenant
	event["event_id"] = randomUUID()
	event["aggregate_id"] = episode
	payload := event["payload"].(map[string]any)
	payload["episode_id"] = episode
	// This live test exercises Kafka ingestion into the RabbitMQ intent ledger.
	// Critical alerts are exclusively handled by the serverless path and must
	// not create RabbitMQ intents.
	payload["severity"] = "warning"
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers...))
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	for i := 0; i < 2; i++ {
		if err := producer.ProduceSync(ctx, &kgo.Record{Topic: topic, Key: []byte(tenant + ":" + episode), Value: raw}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	src, err := newKafkaSource(brokers, "jobs-live-"+randomUUID(), topic)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	metrics := &Metrics{}
	intake := &Intake{DB: db, Source: src, Metrics: metrics, RetryDelay: 100 * time.Millisecond}
	for metrics.EventsDuplicate.Load() == 0 && ctx.Err() == nil {
		if err := intake.PollOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if ctx.Err() != nil {
		t.Fatal("canonical alert not consumed before deadline")
	}
	if n := countRows(t, db, tenant, "SELECT count(*) FROM inbox"); n != 1 {
		t.Fatalf("expected one inbox record after replay, got %d", n)
	}
	if n := countRows(t, db, tenant, "SELECT count(*) FROM notification_intents"); n != 2 {
		t.Fatalf("expected two warning intents after replay, got %d", n)
	}
	if n := countRows(t, db, randomUUID(), "SELECT count(*) FROM notification_intents"); n != 0 {
		t.Fatalf("other tenant can see %d intents", n)
	}
}
