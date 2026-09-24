// Package transport contains the common fail-closed Kafka consumer and producer
// mechanics. Services retain their own topics, group IDs and event semantics.
package transport

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
)

type Client interface {
	PollRecords(context.Context, int) kgo.Fetches
	CommitRecords(context.Context, ...*kgo.Record) error
	CommittedOffsets() map[string]map[int32]kgo.EpochOffset
	ProduceSync(context.Context, ...*kgo.Record) kgo.ProduceResults
	AllowRebalance()
	Ping(context.Context) error
	CloseAllowingRebalance()
}

type Record struct {
	Topic      string
	Key, Value []byte
	Headers    map[string]string
}

// SharedOps implements the identical producer and lifecycle surface of Kafka adapters.
type SharedOps struct{ Client Client }

func (s SharedOps) Publish(ctx context.Context, record Record) error {
	return Publish(ctx, s.Client, record.Topic, record.Key, record.Value, record.Headers)
}
func (s SharedOps) PublishQuarantine(ctx context.Context, record Record) error {
	return s.Publish(ctx, record)
}
func (s SharedOps) Close()                         { s.Client.CloseAllowingRebalance() }
func (s SharedOps) Ping(ctx context.Context) error { return s.Client.Ping(ctx) }

// Message preserves the record and high-watermark needed by read-model consumers.
type Message struct {
	EndOffset  int64
	Topic      string
	Partition  int32
	Offset     int64
	Key, Value []byte
	Headers    []kgo.RecordHeader
	Commit     func(context.Context) error
}

func NextMessage(ctx context.Context, client Client, offsetLost error) (Message, error) {
	record, fetches, err := Next(ctx, client, offsetLost)
	if err != nil {
		return Message{}, err
	}
	return Message{EndOffset: FetchEnd(fetches, record), Topic: record.Topic, Partition: record.Partition,
		Offset: record.Offset, Key: record.Key, Value: record.Value, Headers: record.Headers,
		Commit: func(ctx context.Context) error { return client.CommitRecords(ctx, record) }}, nil
}

// Options never resets an expired committed offset. A new group reads from the
// beginning, while a group whose retained prefix is lost must stop for repair.
func Options(brokers []string, group string, topics []string, extra ...kgo.Opt) []kgo.Opt {
	opts := []kgo.Opt{
		kgo.SeedBrokers(brokers...), kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topics...), kgo.DisableAutoCommit(),
		kgo.ConsumeStartOffset(kgo.NewOffset().AtStart()),
		kgo.ConsumeResetOffset(kgo.NoResetOffset()), kgo.BlockRebalanceOnPoll(),
		kgo.RequiredAcks(kgo.AllISRAcks()), kgo.RebalanceTimeout(time.Minute),
		kgo.RecordDeliveryTimeout(15 * time.Second), kgo.ProducerLinger(0),
		kgo.FetchMaxBytes(4 * 1024 * 1024), kgo.FetchMaxPartitionBytes(1024 * 1024),
	}
	return append(opts, extra...)
}

func Next(ctx context.Context, client Client, offsetLost error) (*kgo.Record, kgo.Fetches, error) {
	client.AllowRebalance()
	for {
		fetches := client.PollRecords(ctx, 1)
		if err := FetchError(client, fetches, offsetLost); err != nil {
			return nil, fetches, err
		}
		if records := fetches.Records(); len(records) != 0 {
			return records[0], fetches, nil
		}
	}
}

func FetchError(client Client, fetches kgo.Fetches, offsetLost error) error {
	var lost error
	fetches.EachError(func(topic string, partition int32, err error) {
		if lost != nil || !errors.Is(err, kerr.OffsetOutOfRange) {
			return
		}
		offset := "unknown"
		if committed, ok := client.CommittedOffsets()[topic][partition]; ok {
			offset = fmt.Sprint(committed.Offset)
		}
		lost = fmt.Errorf("%w: topic=%s partition=%d committed_offset=%s: %w", offsetLost, topic, partition, offset, err)
	})
	if lost != nil {
		return lost
	}
	return fetches.Err()
}

func FetchEnd(fetches kgo.Fetches, record *kgo.Record) int64 {
	var end int64
	fetches.EachPartition(func(partition kgo.FetchTopicPartition) {
		if partition.Topic == record.Topic && partition.Partition == record.Partition {
			end = partition.HighWatermark
		}
	})
	return end
}

func Publish(ctx context.Context, client Client, topic string, key, value []byte, headers map[string]string) error {
	keys := make([]string, 0, len(headers))
	for name := range headers {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	kafkaHeaders := make([]kgo.RecordHeader, 0, len(keys))
	for _, name := range keys {
		kafkaHeaders = append(kafkaHeaders, kgo.RecordHeader{Key: name, Value: []byte(headers[name])})
	}
	return client.ProduceSync(ctx, &kgo.Record{Topic: topic, Key: key, Value: value, Headers: kafkaHeaders}).FirstErr()
}
