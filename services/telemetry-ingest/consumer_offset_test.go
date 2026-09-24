package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
)

// An expired committed canonical offset stops the consumer instead of skipping
// binding events; a new group starts at the log start.
func TestBindingKafkaExpiredCommitIsFatal(t *testing.T) {
	c := bindingCluster(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	admin := bindingTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	for i := 0; i < 4; i++ {
		if err := admin.ProduceSync(ctx, &kgo.Record{Topic: bindingTopic, Partition: 0, Value: []byte("{}")}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	meta := kmsg.NewPtrMetadataRequest()
	topic := kmsg.NewMetadataRequestTopic()
	topic.Topic = kmsg.StringPtr(bindingTopic)
	meta.Topics = append(meta.Topics, topic)
	metadata, err := meta.RequestWith(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	commit := kmsg.NewPtrOffsetCommitRequest()
	commit.Group, commit.Generation = "expired", -1
	commit.Topics = []kmsg.OffsetCommitRequestTopic{{Topic: bindingTopic, TopicID: metadata.Topics[0].TopicID,
		Partitions: []kmsg.OffsetCommitRequestTopicPartition{{Partition: 0, Offset: 1, LeaderEpoch: -1}}}}
	if r, err := commit.RequestWith(ctx, admin); err != nil || r.Topics[0].Partitions[0].ErrorCode != 0 {
		t.Fatal(r, err)
	}
	del := kmsg.NewPtrDeleteRecordsRequest()
	del.TimeoutMillis = 5000
	del.Topics = []kmsg.DeleteRecordsRequestTopic{{Topic: bindingTopic, Partitions: []kmsg.DeleteRecordsRequestTopicPartition{{Partition: 0, Offset: 2}}}}
	if r, err := del.RequestWith(ctx, admin); err != nil || r.Topics[0].Partitions[0].ErrorCode != 0 {
		t.Fatal(r, err)
	}
	old := makeBindingClient
	makeBindingClient = func(opts ...kgo.Opt) (bindingKafkaClient, error) {
		return old(append(opts, kgo.Dialer(c.network.DialContext))...)
	}
	t.Cleanup(func() { makeBindingClient = old })
	expired, err := newBindingKafka(c.ListenAddrs(), "expired")
	if err != nil {
		t.Fatal(err)
	}
	defer expired.Close()
	_, lost := expired.Next(ctx)
	if err := lost; !errors.Is(err, kerr.OffsetOutOfRange) || !errors.Is(err, errCommittedOffsetLost) {
		t.Fatalf("expected out-of-range failure, got %v", err)
	}
	assertBindingRecoveryContext(t, lost)
	fresh, err := newBindingKafka(c.ListenAddrs(), "fresh")
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if m, err := fresh.Next(ctx); err != nil || m.Offset != 2 {
		t.Fatalf("offset %d err %v", m.Offset, err)
	}
}

// KAFKA_BROKERS unset: no consumer, no freshness gate; ingest behaves as before.
func TestNoBrokersLeavesIngestUngated(t *testing.T) {
	app := App{Ping: func(context.Context) error { return nil }, Ingestor: &Ingestor{}}
	worker, err := startBindingConsumer(context.Background(), nil, ingestConfig{BindingFeedMaxStale: time.Minute}, cfgEnv(nil), &app)
	if err != nil || worker.done != nil || app.Ingestor.feed != nil || app.Consumer != nil || app.Feed != nil {
		t.Fatal("unset KAFKA_BROKERS must not wire the consumer or gate", err)
	}
	worker.close()
}

type lostBindingKafka struct{ fakeBindingKafka }

func (f *lostBindingKafka) PollRecords(context.Context, int) kgo.Fetches {
	return kgo.Fetches{{Topics: []kgo.FetchTopic{{Topic: bindingTopic, Partitions: []kgo.FetchPartition{
		{Partition: 0, Err: errBoom}, {Partition: 1, Err: kerr.OffsetOutOfRange},
		{Partition: 2, Err: kerr.OffsetOutOfRange}, {Partition: 3, Records: []*kgo.Record{{Value: []byte("{}")}}},
	}}}}}
}
func TestBindingLostOffsetTakesPriority(t *testing.T) {
	k := &BindingKafka{client: &lostBindingKafka{}}
	m, err := k.Next(context.Background())
	if !errors.Is(err, errCommittedOffsetLost) || !strings.Contains(err.Error(), "committed_offset=unknown") || m.Commit != nil {
		t.Fatal(m, err)
	}
}

func assertBindingRecoveryContext(t *testing.T, lost error) {
	t.Helper()
	for _, want := range []string{bindingTopic, "partition=0", "committed_offset=1", "replay retained inventory outbox", "docs/WAL_RETENTION.md"} {
		if !strings.Contains(lost.Error(), want) {
			t.Fatalf("missing %s: %v", want, lost)
		}
	}
}
