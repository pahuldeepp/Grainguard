package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

func TestCanonicalReferenceReadsBrokerAndRejectsExpiredPrefix(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c := cluster(t)
	producer := kafkaTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	tenant := randomUUID()
	m := message(dbEvent(t, tenant, randomUUID(), 1))
	if err := producer.ProduceSync(ctx, &kgo.Record{Topic: m.Topic, Partition: 0, Key: m.Key, Value: m.Value, Headers: m.Headers}).FirstErr(); err != nil {
		t.Fatal(err)
	}
	parts, err := replayBounds(ctx, producer)
	if err != nil {
		t.Fatal(err)
	}
	client := kafkaTestClient(t, c, kgo.ConsumeResetOffset(kgo.NoResetOffset()))
	result, err := canonicalReference(ctx, client, parts, testProcessor(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 || len(result[tenant].Latest) != 1 {
		t.Fatalf("wrong broker fold: %+v", result)
	}
	parts[0].Start = 1
	_, err = canonicalReference(ctx, client, parts, testProcessor(t))
	if err == nil || !strings.Contains(err.Error(), "prefix") {
		t.Fatalf("expired prefix accepted: %v", err)
	}
}

func TestCanonicalTenantSetRejectsMissingAndExtra(t *testing.T) {
	source := map[string]referenceState{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": {}}
	if err := canonicalTenantSet(source, []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}); err != nil {
		t.Fatal(err)
	}
	if err := canonicalTenantSet(source, nil); err == nil {
		t.Fatal("missing tenant accepted")
	}
	if err := canonicalTenantSet(source, []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}); err == nil {
		t.Fatal("extra tenant accepted")
	}
}

func TestCanonicalReferenceRejectsPoison(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c := cluster(t)
	producer := kafkaTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	if err := producer.ProduceSync(ctx, &kgo.Record{Topic: topicTelemetry, Partition: 0, Key: []byte("bad"), Value: []byte("{}")}).FirstErr(); err != nil {
		t.Fatal(err)
	}
	parts, err := replayBounds(ctx, producer)
	if err != nil {
		t.Fatal(err)
	}
	client := kafkaTestClient(t, c, kgo.ConsumeResetOffset(kgo.NoResetOffset()))
	_, err = canonicalReference(ctx, client, parts, testProcessor(t))
	if err == nil || !strings.Contains(err.Error(), "poison") {
		t.Fatalf("poison accepted: %v", err)
	}
}
