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

const expiredGroup = "expired"

func retentionFixture(t *testing.T, ctx context.Context) (*testCluster, *kgo.Client) {
	t.Helper()
	c := cluster(t)
	admin := kafkaTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	for i := 0; i < 4; i++ {
		if err := admin.ProduceSync(ctx, &kgo.Record{Topic: rawTelemetry, Partition: 0, Value: []byte("null")}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	commitOffset(t, ctx, admin, expiredGroup, 1)
	commitOffset(t, ctx, admin, "resume", 3)
	del := kmsg.NewPtrDeleteRecordsRequest()
	del.TimeoutMillis = 5000
	del.Topics = []kmsg.DeleteRecordsRequestTopic{{Topic: rawTelemetry, Partitions: []kmsg.DeleteRecordsRequestTopicPartition{{Partition: 0, Offset: 2}}}}
	resp, err := del.RequestWith(ctx, admin)
	if err != nil || resp.Topics[0].Partitions[0].ErrorCode != 0 || resp.Topics[0].Partitions[0].LowWatermark != 2 {
		t.Fatal(resp, err)
	}
	old := makeClient
	makeClient = func(options ...kgo.Opt) (kafkaClient, error) {
		return old(append(options, kgo.Dialer(c.network.DialContext))...)
	}
	t.Cleanup(func() { makeClient = old })
	return c, admin
}

func commitOffset(t *testing.T, ctx context.Context, admin *kgo.Client, group string, offset int64) {
	t.Helper()
	meta := kmsg.NewPtrMetadataRequest()
	meta.Topics = []kmsg.MetadataRequestTopic{{Topic: kmsg.StringPtr(rawTelemetry)}}
	metadata, err := meta.RequestWith(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	commit := kmsg.NewPtrOffsetCommitRequest()
	commit.Group, commit.Generation = group, -1
	commit.Topics = []kmsg.OffsetCommitRequestTopic{{Topic: rawTelemetry, TopicID: metadata.Topics[0].TopicID, Partitions: []kmsg.OffsetCommitRequestTopicPartition{{Partition: 0, Offset: offset, LeaderEpoch: -1}}}}
	response, err := commit.RequestWith(ctx, admin)
	if err != nil || response.Topics[0].Partitions[0].ErrorCode != 0 {
		t.Fatal(response, err)
	}
}

func TestRetentionFreshAndResume(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c, _ := retentionFixture(t, ctx)
	for _, tc := range []struct {
		group  string
		offset int64
	}{{"fresh", 2}, {"resume", 3}} {
		t.Run(tc.group, func(t *testing.T) {
			adapter, err := newKafka(c.ListenAddrs(), tc.group)
			if err != nil {
				t.Fatal(err)
			}
			defer adapter.Close()
			m, err := adapter.Next(ctx)
			if err != nil || m.Offset != tc.offset || m.Topic != rawTelemetry {
				t.Fatalf("got %+v, %v; want offset %d", m, err, tc.offset)
			}
			if err := m.Commit(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCommittedOffsetOutOfRangeIsFatal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c, admin := retentionFixture(t, ctx)
	adapter, err := newKafka(c.ListenAddrs(), expiredGroup)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	p := testProcessor(t)
	p.Source = adapter
	err = p.Run(ctx)
	if !errors.Is(err, errCommittedOffsetLost) || !errors.Is(err, kerr.OffsetOutOfRange) {
		t.Fatalf("expected fatal retention error: %v", err)
	}
	for _, want := range []string{rawTelemetry, "partition=0", "committed_offset=1", "fresh connector name and slot"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("missing %q: %v", want, err)
		}
	}
	if p.Metrics.consumed.Load() != 0 {
		t.Fatal("processed records after retention loss")
	}
	req := kmsg.NewPtrOffsetFetchRequest()
	req.Group = expiredGroup
	req.Topics = []kmsg.OffsetFetchRequestTopic{{Topic: rawTelemetry, Partitions: []int32{0}}}
	response, err := req.RequestWith(ctx, admin)
	if err != nil || response.Topics[0].Partitions[0].Offset != 1 {
		t.Fatalf("commit advanced: %+v, %v", response, err)
	}
}

// A poll may contain records and errors from different partitions. Fail before
// exposing any record, even when the retention error is not the first error.
func TestRetentionErrorTakesPriority(t *testing.T) {
	fake := &retentionKafka{fakeKafka: fakeKafka{}}
	adapter := &Kafka{client: fake}
	m, err := adapter.Next(context.Background())
	if !errors.Is(err, errCommittedOffsetLost) || !strings.Contains(err.Error(), "committed_offset=unknown") {
		t.Fatal(err)
	}
	if m.Commit != nil || m.Value != nil || fake.committed {
		t.Fatal("record exposed or committed")
	}
}

type retentionKafka struct{ fakeKafka }

func (f *retentionKafka) PollRecords(context.Context, int) kgo.Fetches {
	return kgo.Fetches{{Topics: []kgo.FetchTopic{{Topic: rawTelemetry, Partitions: []kgo.FetchPartition{
		{Partition: 0, Err: errTest},
		{Partition: 1, Err: kerr.OffsetOutOfRange},
		{Partition: 2, Err: kerr.OffsetOutOfRange},
		{Partition: 3, Records: []*kgo.Record{{Value: []byte("null")}}},
	}}}}}
}
