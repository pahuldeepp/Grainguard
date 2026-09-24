package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/twmb/franz-go/pkg/kfake"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

func heartbeatMessage() Message {
	return Message{Topic: rawInventory, Offset: 42, Value: []byte(`{"op":"m","source":{"db":"greenguard_inventory","lsn":123,"txId":5,"ts_ms":1790000000000},"message":{"prefix":"greenguard.binding-feed","content":"Y2hlY2twb2ludA=="}}`)}
}
func TestBindingHeartbeatSourceValidationAndFanout(t *testing.T) {
	m := heartbeatMessage()
	records, ok := heartbeatRecords(m)
	if !ok || len(records) != 6 {
		t.Fatal(records, ok)
	}
	for i, r := range records {
		var cp map[string]any
		_ = json.Unmarshal(r.Value, &cp)
		if r.Topic != topicInventory || string(r.Key) != feedKey || cp["source_position"] != "123" || cp["raw_position"] != float64(42) {
			t.Fatal(cp)
		}
		p := feedPartitioner{}.ForTopic(topicInventory)
		kr := &kgo.Record{Key: r.Key, Headers: []kgo.RecordHeader{{Key: "binding_partition", Value: []byte(r.Headers["binding_partition"])}}}
		if p.Partition(kr, 6) != i || !p.RequiresConsistency(kr) {
			t.Fatal("checkpoint missed a partition")
		}
		if p.Partition(kr, 7) != -1 {
			t.Fatal("partition drift accepted")
		}
	}
}

func TestBindingHeartbeatRejectsInvalidSource(t *testing.T) {
	m := heartbeatMessage()
	for _, body := range []string{"{", "[]", `{"op":"c"}`, `{"op":"m"}`, `{"op":"m","source":{"db":"greenguard_inventory"},"message":{"prefix":"greenguard.binding-feed"}}`} {
		bad := m
		bad.Value = []byte(body)
		if _, ok := heartbeatRecords(bad); ok {
			t.Fatal(body)
		}
	}
	for _, field := range []string{"lsn", "txId", "ts_ms"} {
		var envelope map[string]any
		_ = json.Unmarshal(m.Value, &envelope)
		envelope["source"].(map[string]any)[field] = -1
		bad := m
		bad.Value, _ = json.Marshal(envelope)
		if _, ok := heartbeatRecords(bad); ok {
			t.Fatal(field)
		}
	}
	wrapped := m
	wrapped.Value = append(append([]byte(`{"payload":`), m.Value...), '}')
	if _, ok := heartbeatRecords(wrapped); !ok {
		t.Fatal("schema wrapper rejected")
	}
	if _, ok := positiveSourceNumber(json.Number("1.5")); ok {
		t.Fatal("fractional position accepted")
	}
}

func TestFeedPartitionerBounds(t *testing.T) {
	p := feedPartitioner{}.ForTopic(topicInventory)
	if part := p.Partition(&kgo.Record{Key: []byte("tenant:device")}, 6); part < 0 || part >= 6 {
		t.Fatal(part)
	}
	for _, value := range []string{"bad", "-1", "6"} {
		if p.Partition(&kgo.Record{Headers: []kgo.RecordHeader{{Key: "binding_partition", Value: []byte(value)}}}, 6) != -1 {
			t.Fatal(value)
		}
	}
}
func TestBindingHeartbeatCommitOnlyAfterAllPartitions(t *testing.T) {
	p := testProcessor(t)
	m := heartbeatMessage()
	published := 0
	p.Sink = sinkFunc(func(context.Context, Record) error { published++; return nil })
	m.Commit = func(context.Context) error {
		if published != 6 {
			t.Fatal("barrier committed before fanout")
		}
		return nil
	}
	if err := p.process(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	p.Sink = sinkFunc(func(context.Context, Record) error { cancel(); return errTest })
	if err := p.process(ctx, m); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestBindingHeartbeatKafkaFanout(t *testing.T) {
	network := new(kfake.VirtualNetwork)
	cluster, err := kfake.NewCluster(kfake.ListenFn(network.Listen), kfake.NumBrokers(1), kfake.SeedTopics(6, topicInventory), kfake.SeedTopics(1, rawInventory, rawTelemetry, topicQuarantine))
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	old := makeClient
	makeClient = func(opts ...kgo.Opt) (kafkaClient, error) {
		return old(append(opts, kgo.Dialer(network.DialContext))...)
	}
	defer func() { makeClient = old }()
	adapter, err := newKafka(cluster.ListenAddrs(), "heartbeat-test")
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	p := testProcessor(t)
	p.Sink = adapter
	m := heartbeatMessage()
	committed := false
	m.Commit = func(context.Context) error { committed = true; return nil }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := p.process(ctx, m); err != nil || !committed {
		t.Fatal(err)
	}
	reader, err := kgo.NewClient(kgo.SeedBrokers(cluster.ListenAddrs()...), kgo.Dialer(network.DialContext), kgo.ConsumeTopics(topicInventory), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	seen := map[int32]bool{}
	for len(seen) < 6 {
		fetched := reader.PollRecords(ctx, 6)
		if err := fetched.Err(); err != nil {
			t.Fatal(err)
		}
		for _, record := range fetched.Records() {
			if string(record.Key) != feedKey {
				t.Fatal("wrong checkpoint key")
			}
			seen[record.Partition] = true
		}
	}
}
