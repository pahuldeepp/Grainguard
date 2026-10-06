package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
)

func TestTopicPrefixIsolatesHeartbeatAndPreservesSourceCoordinates(t *testing.T) {
	const prefix = "provisioning-demo."
	network := new(kfake.VirtualNetwork)
	cluster, err := kfake.NewCluster(kfake.ListenFn(network.Listen), kfake.NumBrokers(1), kfake.SeedTopics(6, prefix+topicInventory), kfake.SeedTopics(1, prefix+rawInventory, prefix+topicQuarantine))
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	old := makeClient
	makeClient = func(opts ...kgo.Opt) (kafkaClient, error) {
		return old(append(opts, kgo.Dialer(network.DialContext))...)
	}
	defer func() { makeClient = old }()
	adapter, err := newKafkaWithPrefix(cluster.ListenAddrs(), "isolated-prefix", prefix)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	writer, err := kgo.NewClient(kgo.SeedBrokers(cluster.ListenAddrs()...), kgo.Dialer(network.DialContext))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	heartbeat := heartbeatMessage()
	if err := writer.ProduceSync(ctx, &kgo.Record{Topic: prefix + rawInventory, Value: heartbeat.Value}).FirstErr(); err != nil {
		t.Fatal(err)
	}
	m, err := adapter.Next(ctx)
	if err != nil || m.Topic != rawInventory || m.TransportTopic != prefix+rawInventory {
		t.Fatalf("normalized source %+v: %v", m, err)
	}
	p := testProcessor(t)
	p.Sink = adapter
	if err := p.process(ctx, m); err != nil {
		t.Fatal(err)
	}
	q := quarantineRecord(m, fail(reasonSchema, "invalid"))
	var body quarantine
	if err := json.Unmarshal(q.Value, &body); err != nil {
		t.Fatal(err)
	}
	if body.Topic != prefix+rawInventory || q.Headers["source_topic"] != prefix+rawInventory {
		t.Fatal("quarantine lost actual transport source", q)
	}
	if err := adapter.PublishQuarantine(ctx, q); err != nil {
		t.Fatal(err)
	}
	reader, err := kgo.NewClient(kgo.SeedBrokers(cluster.ListenAddrs()...), kgo.Dialer(network.DialContext), kgo.ConsumeTopics(prefix+topicInventory, prefix+topicQuarantine), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	seen := map[int32]bool{}
	quarantined := false
	for len(seen) < 6 || !quarantined {
		f := reader.PollFetches(ctx)
		if err := f.Err(); err != nil {
			t.Fatal(err)
		}
		for _, r := range f.Records() {
			if r.Topic == prefix+topicInventory {
				if string(r.Key) != feedKey {
					t.Fatal("wrong key")
				}
				seen[r.Partition] = true
			} else if r.Topic == prefix+topicQuarantine {
				quarantined = true
			} else {
				t.Fatal("publication escaped namespace", r.Topic)
			}
		}
	}
}

func TestTopicPrefixRejectsInvalidNamespace(t *testing.T) {
	for _, prefix := range []string{"missing-dot", "bad space.", "../.", "é.", "命名.", strings.Repeat("a", 249-len(topicRiskInvalidated)) + "."} {
		if _, err := newKafkaWithPrefix(nil, "test", prefix); err == nil {
			t.Fatal("accepted invalid prefix", prefix)
		}
	}
}

func TestTopicPrefixAllowsMaximumKafkaTopicLength(t *testing.T) {
	old := makeClient
	defer func() { makeClient = old }()
	makeClient = func(...kgo.Opt) (kafkaClient, error) { return &fakeKafka{}, nil }
	prefix := strings.Repeat("a", 248-len(topicRiskInvalidated)) + "."
	if len(prefix+topicRiskInvalidated) != 249 {
		t.Fatal("incorrect boundary fixture")
	}
	k, err := newKafkaWithPrefix([]string{"localhost:9092"}, "boundary", prefix)
	if err != nil {
		t.Fatal(err)
	}
	k.Close()
}
