package saga

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// This opt-in check crosses the real Postgres outbox/Kafka boundary. It does
// not restart the shared local broker, which other live suites may be using.
func TestLiveKafkaCommandAndDuplicateResult(t *testing.T) {
	if os.Getenv("SAGA_KAFKA_LIVE") != "1" {
		t.Skip("SAGA_KAFKA_LIVE=1 enables real Kafka check")
	}
	pool := testPool(t)
	brokers := strings.Split(os.Getenv("KAFKA_BROKERS"), ",")
	if len(brokers) == 0 || brokers[0] == "" {
		t.Skip("KAFKA_BROKERS is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.RequiredAcks(kgo.AllISRAcks()))
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()
	consumer, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.ConsumerGroup("saga-live-"+testUUID(t)),
		kgo.ConsumeTopics(CommandTopic), kgo.DisableAutoCommit(),
		kgo.ConsumeStartOffset(kgo.NewOffset().AtStart()), kgo.FetchIsolationLevel(kgo.ReadCommitted()))
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	store := Store{DB: pool}
	tenant := testUUID(t)
	snap, err := store.Start(ctx, StartRequest{TenantID: tenant, IdempotencyKey: testUUID(t),
		DeviceID: testUUID(t), AssetID: testUUID(t)})
	if err != nil {
		t.Fatal(err)
	}
	sent, err := store.PublishNextCommand(ctx, tenant, func(ctx context.Context, key, value []byte) error {
		return producer.ProduceSync(ctx, &kgo.Record{Topic: CommandTopic, Key: key, Value: value}).FirstErr()
	})
	if err != nil || !sent {
		t.Fatalf("publish command: sent=%v err=%v", sent, err)
	}
	command := awaitKafkaCommand(t, ctx, consumer, tenant, snap.SagaID)
	result := Result{StepResult: StepResult{TenantID: tenant, SagaID: snap.SagaID,
		CommandID: command.CommandID, ResultID: testUUID(t), SagaVersion: 1,
		FencingToken: 1, Outcome: "succeeded"}, Step: "asset.reserve"}
	value, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	key := []byte(tenant + ":" + snap.SagaID)
	for range 2 { // duplicate Kafka publication must only advance once
		if err := producer.ProduceSync(ctx, &kgo.Record{Topic: ResultTopic, Key: key, Value: value}).FirstErr(); err != nil {
			t.Fatal(err)
		}
		updated, err := store.ApplyResultRecord(ctx, key, value)
		if err != nil || updated.State != "configuring" || updated.Version != 2 {
			t.Fatalf("result replay: %+v err=%v", updated, err)
		}
	}
}

// awaitKafkaCommand polls until the saga's first command arrives or ctx ends.
func awaitKafkaCommand(t *testing.T, ctx context.Context, consumer *kgo.Client, tenant, sagaID string) Command {
	t.Helper()
	for ctx.Err() == nil {
		fetches := consumer.PollRecords(ctx, 100)
		if err := fetches.Err(); err != nil {
			t.Fatal(err)
		}
		if command, ok := matchKafkaCommand(t, fetches.Records(), tenant, sagaID); ok {
			return command
		}
	}
	t.Fatalf("command not observed before deadline: %v", ctx.Err())
	return Command{}
}

func matchKafkaCommand(t *testing.T, records []*kgo.Record, tenant, sagaID string) (Command, bool) {
	t.Helper()
	for _, record := range records {
		var candidate Command
		if err := json.Unmarshal(record.Value, &candidate); err != nil {
			continue // unrelated historical records from this topic
		}
		if candidate.SagaID != sagaID {
			continue
		}
		if string(record.Key) != tenant+":"+sagaID || candidate.Step != "asset.reserve" {
			t.Fatalf("unexpected Kafka command: %s %+v", record.Key, candidate)
		}
		if candidate.CommandID != "" {
			return candidate, true
		}
		return candidate, false
	}
	return Command{}, false
}
