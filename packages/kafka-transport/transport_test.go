package transport

import (
	"context"
	"errors"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"strings"
	"testing"
)

type fakeClient struct {
	polls     int
	committed bool
	record    *kgo.Record
}

func (f *fakeClient) PollRecords(context.Context, int) kgo.Fetches {
	f.polls++
	if f.polls == 1 {
		return nil
	}
	return kgo.Fetches{{Topics: []kgo.FetchTopic{{Topic: "readings", Partitions: []kgo.FetchPartition{{Partition: 0, HighWatermark: 12, Records: []*kgo.Record{{Topic: "readings", Partition: 0, Offset: 11}}}}}}}}
}
func (f *fakeClient) CommitRecords(context.Context, ...*kgo.Record) error {
	f.committed = true
	return nil
}
func (f *fakeClient) CommittedOffsets() map[string]map[int32]kgo.EpochOffset {
	return map[string]map[int32]kgo.EpochOffset{"readings": {0: {Offset: 7}}}
}
func (f *fakeClient) ProduceSync(_ context.Context, records ...*kgo.Record) kgo.ProduceResults {
	f.record = records[0]
	return kgo.ProduceResults{{Record: records[0]}}
}
func (f *fakeClient) AllowRebalance()            {}
func (f *fakeClient) Ping(context.Context) error { return nil }
func (f *fakeClient) CloseAllowingRebalance()    {}

func TestOffsetLossStopsConsumerAndReportsCommittedPosition(t *testing.T) {
	f := &fakeClient{}
	sentinel := errors.New("retention lost")
	fetches := kgo.Fetches{{Topics: []kgo.FetchTopic{{Topic: "readings", Partitions: []kgo.FetchPartition{{Partition: 0, Err: kerr.OffsetOutOfRange}}}}}}
	err := FetchError(f, fetches, sentinel)
	if !errors.Is(err, sentinel) || !errors.Is(err, kerr.OffsetOutOfRange) || !strings.Contains(err.Error(), "committed_offset=7") {
		t.Fatal(err)
	}
}
func TestNextAndPublishPreserveTransportContract(t *testing.T) {
	f := &fakeClient{}
	record, fetches, err := Next(context.Background(), f, errors.New("retention lost"))
	if err != nil || record.Offset != 11 || FetchEnd(fetches, record) != 12 {
		t.Fatal(record, err)
	}
	if f.polls != 2 {
		t.Fatalf("polls=%d", f.polls)
	}
	if err := Publish(context.Background(), f, "alerts", []byte("k"), []byte("v"), map[string]string{"z": "2", "a": "1"}); err != nil {
		t.Fatal(err)
	}
	if f.record.Topic != "alerts" || string(f.record.Key) != "k" || len(f.record.Headers) != 2 || f.record.Headers[0].Key != "a" || f.record.Headers[1].Key != "z" {
		t.Fatalf("record=%+v", f.record)
	}
}
