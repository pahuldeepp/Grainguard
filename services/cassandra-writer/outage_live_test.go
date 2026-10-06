package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"greenguard.local/cassandra-writer/history"
)

// This disruptive opt-in test owns the local Cassandra node for its duration.
// It proves a durable broker offset is held across an outage and replayed after
// a fresh worker starts. It always restarts the container on test cleanup.
func TestLiveCassandraNodeOutageCatchUp(t *testing.T) {
	t.Setenv("KAFKA_TOPIC_PREFIX", "") // This acceptance fixture intentionally uses canonical shared topics.
	if os.Getenv("KAFKA_CASSANDRA_FAULT_LIVE") != "1" {
		t.Skip("set KAFKA_CASSANDRA_FAULT_LIVE=1 to stop the local Cassandra container")
	}
	container := os.Getenv("CASSANDRA_TEST_CONTAINER")
	if container == "" {
		container = "greenguard-dev-cassandra-1"
	}
	control := func(timeout time.Duration, action string) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		out, err := exec.CommandContext(ctx, "docker", action, container).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %s %s: %v: %s", action, container, err, out)
		}
	}
	// Cassandra's first cold start can take longer on a developer laptop when
	// the local Kafka/observability stacks are also running. Keep the test
	// bounded, but leave enough time for stop, startup, health discovery and the
	// durable Kafka offset/readback checks as separate phases.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	brokers := strings.Split(os.Getenv("KAFKA_BROKERS"), ",")
	if brokers[0] == "" {
		brokers = []string{"127.0.0.1:59092"}
	}
	admin, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.RecordPartitioner(kgo.ManualPartitioner()), kgo.RequiredAcks(kgo.AllISRAcks()))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if err := admin.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	group := "cassandra-outage-" + uuid()
	baseline := topicEnds(t, ctx, admin, topicTelemetry)
	commitBaseline(t, ctx, admin, group, baseline)
	event, tenant, device, reading := recoveryEvent(t)
	record := &kgo.Record{Topic: topicTelemetry, Partition: 0, Key: []byte(tenant + ":" + device), Value: event,
		Headers: []kgo.RecordHeader{{Key: fieldTenant, Value: []byte(tenant)}, {Key: fieldEvent, Value: []byte(reading.event)}, {Key: fieldType, Value: []byte(typeTelemetry)}, {Key: fieldSchema, Value: []byte("1")}}}
	if err := admin.ProduceSync(ctx, record).FirstErr(); err != nil {
		t.Fatal(err)
	}
	if record.Offset != baseline[0] {
		t.Fatalf("source offset %d, want %d", record.Offset, baseline[0])
	}
	cfg, err := history.LoadConfig(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	activeSession, err := history.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer activeSession.Close()
	control(30*time.Second, "stop")
	stopped := true
	t.Cleanup(func() {
		if stopped {
			control(60*time.Second, "start")
		}
	})
	schema := assertCassandraOutage(t, ctx, brokers, group, activeSession, admin, record)
	control(60*time.Second, "start")
	stopped = false
	session := waitForCassandraRecovery(t, ctx, cfg)
	defer session.Close()
	assertCassandraCatchUp(t, ctx, catchUpArgs{brokers, group, session, admin, record, tenant, device, reading, schema})
	t.Logf("outage/catch-up passed: group=%s held=%d committed=%d row=%s", group, record.Offset, record.Offset+1, reading.id)
}

func waitForCassandraRecovery(t *testing.T, ctx context.Context, cfg history.Config) *history.CQLSession {
	t.Helper()
	var session *history.CQLSession
	var err error
	for ctx.Err() == nil {
		session, err = history.Open(cfg)
		if err == nil {
			err = session.Ping(ctx)
			if err == nil {
				break
			}
			session.Close()
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
	if err != nil {
		t.Fatalf("Cassandra did not recover: %v", err)
	}
	return session
}

func assertCassandraOutage(t *testing.T, ctx context.Context, brokers []string, group string, activeSession *history.CQLSession, admin *kgo.Client, record *kgo.Record) Validator {
	t.Helper()
	consumer, err := newKafka(brokers, group)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := loadSchema("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	message, err := consumer.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if message.Offset != record.Offset || message.Partition != 0 {
		t.Fatalf("unexpected fetched record: %d/%d", message.Partition, message.Offset)
	}
	storeWhileDown := &history.Store{Session: activeSession, TTL: 24 * time.Hour}
	paused := &Processor{Source: consumer, Sink: consumer, Schema: schema, Store: storeWhileDown, Transient: history.Transient, Rejected: history.Rejected, Attempts: 2, RetryDelay: 100 * time.Millisecond, ProcessTimeout: 8 * time.Second}
	paused.Ready.Store(true)
	// The resilient processor holds an unavailable write until cancellation.
	// Bound only this outage phase; keep the parent alive for offset verification
	// and recovery after the node restarts.
	outageCtx, cancelOutage := context.WithTimeout(ctx, 10*time.Second)
	defer cancelOutage()
	if err := paused.process(outageCtx, message); err == nil {
		t.Fatal("write succeeded while Cassandra was stopped")
	}
	if paused.Ready.Load() {
		t.Fatal("consumer remained ready after failed Cassandra write")
	}
	consumer.Close()
	if got := committedOffset(t, ctx, admin, group, 0); got != record.Offset {
		t.Fatalf("outage advanced offset to %d, want %d", got, record.Offset)
	}
	return schema
}

type catchUpArgs struct {
	brokers []string
	group   string
	session *history.CQLSession
	admin   *kgo.Client
	record  *kgo.Record
	tenant  string
	device  string
	reading recoveryReading
	schema  Validator
}

func assertCassandraCatchUp(t *testing.T, ctx context.Context, args catchUpArgs) {
	t.Helper()
	consumer, err := newKafka(args.brokers, args.group)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	message, err := consumer.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if message.Offset != args.record.Offset || message.Partition != 0 {
		t.Fatalf("catch-up record: %d/%d, want 0/%d", message.Partition, message.Offset, args.record.Offset)
	}
	store := &history.Store{Session: args.session, TTL: 24 * time.Hour, MaxRows: 10, MaxDays: 2}
	p := &Processor{Source: consumer, Sink: consumer, Schema: args.schema, Store: store, Transient: history.Transient, Rejected: history.Rejected, Attempts: 5, RetryDelay: 100 * time.Millisecond, ProcessTimeout: 20 * time.Second}
	if err := p.process(ctx, message); err != nil {
		t.Fatal(err)
	}
	if got := committedOffset(t, ctx, args.admin, args.group, 0); got != args.record.Offset+1 {
		t.Fatalf("catch-up offset %d, want %d", got, args.record.Offset+1)
	}
	result, err := store.Query(ctx, args.tenant, args.device, args.reading.observed.Add(-time.Second), args.reading.observed.Add(time.Second))
	if err != nil || len(result.Readings) != 1 || result.Readings[0].ReadingID != args.reading.id {
		t.Fatalf("catch-up row: %+v err=%v", result, err)
	}
}
