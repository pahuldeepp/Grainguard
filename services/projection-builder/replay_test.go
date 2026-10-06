package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
)

func TestReplayConfigurationFailsClosed(t *testing.T) {
	for _, tc := range []struct{ action, tenant, url string }{
		{"swap", "", ""}, {"rebuild", "bad", ""},
		{"status", infrastructureTenant, ""},
		{"rebuild", "00000000-0000-4000-8000-000000000002", "postgres://projection_app@localhost/greenguard_read"},
		{"rebuild", "00000000-0000-4000-8000-000000000002", "postgres://postgres@localhost/greenguard_read_replay_test"},
	} {
		env := map[string]string{"PROJECTION_REPLAY_ACTION": tc.action, "PROJECTION_REPLAY_TENANT": tc.tenant, "PROJECTION_REPLAY_DATABASE_URL": tc.url}
		if err := runReplay(context.Background(), func(k string) string { return env[k] }, io.Discard); err == nil {
			t.Fatal("unsafe configuration accepted", tc.action)
		}
	}
	for _, p := range []replayPartition{{Start: 1, End: 10, Next: 5}, {End: 3, Next: 4}, {Next: -1}} {
		if replayCheckBounds(p) == nil {
			t.Fatal("unsafe source bounds accepted", p)
		}
	}
	if replayCheckBounds(replayPartition{}) != nil {
		t.Fatal("empty partition rejected")
	}
}

func TestReplayMainRejectsShardedModeBeforeOpeningAnyDependencies(t *testing.T) {
	err := replayMain(context.Background(), func(key string) string {
		switch key {
		case "SHARD_ROUTING_REQUIRED":
			return "false"
		case "SHARD_REGISTRY_FILE":
			return "/path/not-needed-for-rejection/registry.json"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "sharded operational replay requires an explicit shard migration/replay protocol") {
		t.Fatalf("expected preflight sharded-replay refusal, got %v", err)
	}
}

func replayFixture(t *testing.T, ctx context.Context) (*testCluster, *kgo.Client, []replayPartition, map[string]any) {
	t.Helper()
	c := cluster(t)
	producer := kafkaTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	e := validEvent(t)
	m := message(e)
	for i := 0; i < 2; i++ {
		if err := producer.ProduceSync(ctx, &kgo.Record{Topic: m.Topic, Partition: 0, Key: m.Key, Value: m.Value, Headers: m.Headers}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	parts, err := replayBounds(ctx, producer)
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) != len(projectionTopics)*2 {
		t.Fatal(parts)
	}
	return c, producer, parts, e
}

func TestReplayCheckpointBeforeBrokerCommitAndResume(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c, producer, parts, e := replayFixture(t, ctx)
	client := kafkaTestClient(t, c, kgo.ConsumeResetOffset(kgo.NoResetOffset()))
	applied := 0
	seen := false
	saved := int64(0)
	r := &replayRunner{Client: client, Tenant: e[fieldTenant].(string), Group: "replay-safe-test", Validator: testProcessor(t)}
	r.Apply = func(context.Context, Message, map[string]any) error {
		applied++
		if seen {
			return ErrDuplicate
		}
		seen = true
		return nil
	}
	r.Save = func(_ context.Context, p replayPartition) error {
		saved = p.Next
		if saved == 1 {
			return errTest
		}
		return nil
	}
	if err := r.run(ctx, parts); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	// Effect happened but durable checkpoint failed. Restart at zero re-delivers
	// the same event; the inbox absorbs it. Nothing advances beyond the failed row.
	if applied != 1 || saved != 1 {
		t.Fatal(applied, saved)
	}
	parts, err := replayBounds(ctx, producer)
	if err != nil {
		t.Fatal(err)
	}
	r.Client = kafkaTestClient(t, c, kgo.ConsumeResetOffset(kgo.NoResetOffset()))
	r.Save = func(_ context.Context, p replayPartition) error { saved = p.Next; return nil }
	if err := r.run(ctx, parts); err != nil {
		t.Fatal(err)
	}
	if applied != 3 || saved != 2 {
		t.Fatal(applied, saved)
	}
	req := kmsg.NewPtrOffsetFetchRequest()
	req.Group = r.Group
	req.Topics = []kmsg.OffsetFetchRequestTopic{{Topic: topicTelemetry, Partitions: []int32{0}}}
	resp, err := req.RequestWith(ctx, producer)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Topics) != 1 || resp.Topics[0].Partitions[0].Offset != 2 {
		t.Fatalf("broker offset did not reach durable frontier: %+v", resp)
	}
}

func TestReplayTenantFilterAndPoisonStop(t *testing.T) {
	r := &replayRunner{Tenant: "00000000-0000-4000-8000-000000000002", Validator: testProcessor(t), Apply: func(context.Context, Message, map[string]any) error { t.Fatal("foreign tenant written"); return nil }}
	m := message(validEvent(t))
	record := &kgo.Record{Topic: m.Topic, Key: m.Key, Value: m.Value, Headers: m.Headers}
	if err := r.apply(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	record.Value = []byte(`{}`)
	if err := r.apply(context.Background(), record); err == nil {
		t.Fatal("poison skipped")
	}
}

func TestGlobalReplayAppliesEveryTenantAndRecordsDuplicates(t *testing.T) {
	first := validEvent(t)
	second := validEvent(t)
	second[fieldTenant] = "00000000-0000-4000-8000-000000000002"
	applied := map[string]int{}
	recorded := map[string]int{}
	r := &replayRunner{Tenant: "all", Validator: testProcessor(t)}
	r.Apply = func(_ context.Context, _ Message, e map[string]any) error {
		tenant := e[fieldTenant].(string)
		applied[tenant]++
		if applied[tenant] > 1 {
			return ErrDuplicate
		}
		return nil
	}
	r.RecordTenant = func(_ context.Context, tenant string) error { recorded[tenant]++; return nil }
	for _, e := range []map[string]any{first, second, first} {
		m := message(e)
		if err := r.apply(context.Background(), &kgo.Record{Topic: m.Topic, Key: m.Key, Value: m.Value, Headers: m.Headers}); err != nil {
			t.Fatal(err)
		}
	}
	if len(recorded) != 2 || recorded[first[fieldTenant].(string)] != 2 || recorded[second[fieldTenant].(string)] != 1 {
		t.Fatal("global replay lost tenant coverage", recorded)
	}
	r.RecordTenant = func(context.Context, string) error { return errTest }
	m := message(first)
	if err := r.apply(context.Background(), &kgo.Record{Topic: m.Topic, Key: m.Key, Value: m.Value, Headers: m.Headers}); !errors.Is(err, errTest) {
		t.Fatal("tenant registry failure did not stop global progress", err)
	}
}

func TestReplayRejectsMissingRetainedPrefix(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, producer, _, _ := replayFixture(t, ctx)
	req := kmsg.NewPtrDeleteRecordsRequest()
	req.TimeoutMillis = 5000
	req.Topics = []kmsg.DeleteRecordsRequestTopic{{Topic: topicTelemetry, Partitions: []kmsg.DeleteRecordsRequestTopicPartition{{Partition: 0, Offset: 1}}}}
	resp, err := req.RequestWith(ctx, producer)
	if err != nil || resp.Topics[0].Partitions[0].ErrorCode != 0 {
		t.Fatal(resp, err)
	}
	parts, err := replayBounds(ctx, producer)
	if err != nil {
		t.Fatal(err)
	}
	rejected := false
	for _, p := range parts {
		if err := replayCheckBounds(p); err != nil {
			rejected = strings.Contains(err.Error(), "prefix missing")
		}
	}
	if !rejected {
		t.Fatal("expired prefix accepted")
	}
}

func TestReplayApplyFailureDoesNotSave(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, parts, e := replayFixture(t, ctx)
	r := &replayRunner{Client: kafkaTestClient(t, c, kgo.ConsumeResetOffset(kgo.NoResetOffset())), Tenant: e[fieldTenant].(string), Group: fmt.Sprint("replay-fail-", time.Now().UnixNano()), Validator: testProcessor(t), Apply: func(context.Context, Message, map[string]any) error { return ErrConflict }, Save: func(context.Context, replayPartition) error { t.Fatal("saved rejected event"); return nil }}
	if err := r.run(ctx, parts); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
}
