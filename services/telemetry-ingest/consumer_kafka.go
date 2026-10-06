package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
)

// franz-go provides idempotent production (enabled by default), synchronous
// all-ISR delivery and explicit rebalance blocking. No broker transactions are
// required: canonical identity is stable, and downstream inboxes deduplicate.
type bindingKafkaClient interface {
	PollRecords(context.Context, int) kgo.Fetches
	CommitRecords(context.Context, ...*kgo.Record) error
	CommittedOffsets() map[string]map[int32]kgo.EpochOffset
	ProduceSync(context.Context, ...*kgo.Record) kgo.ProduceResults
	AllowRebalance()
	Ping(context.Context) error
	CloseAllowingRebalance()
}
type BindingKafka struct {
	client      bindingKafkaClient
	topicPrefix string
}

var makeBindingClient = func(options ...kgo.Opt) (bindingKafkaClient, error) { return kgo.NewClient(options...) }

func newBindingKafka(brokers []string, group string) (*BindingKafka, error) {
	prefix := os.Getenv("BINDING_KAFKA_TOPIC_PREFIX")
	if len(prefix+bindingTopic) > 249 || len(prefix+sensorLayoutTopic) > 249 || len(prefix+quarantineTopic) > 249 || strings.IndexFunc(prefix, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-')
	}) >= 0 || strings.Contains(prefix, "..") {
		return nil, errors.New("invalid BINDING_KAFKA_TOPIC_PREFIX")
	}
	security, err := transport.SecurityOptions(os.Getenv)
	if err != nil {
		return nil, err
	}
	options := []kgo.Opt{kgo.SeedBrokers(brokers...), kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(prefix+bindingTopic, prefix+sensorLayoutTopic), kgo.DisableAutoCommit(),
		// New group: log start. Expired commit: fatal (NoResetOffset), never a silent skip.
		kgo.ConsumeStartOffset(kgo.NewOffset().AtStart()), kgo.ConsumeResetOffset(kgo.NoResetOffset()),
		kgo.BlockRebalanceOnPoll(),
		kgo.RequiredAcks(kgo.AllISRAcks()), kgo.RebalanceTimeout(time.Minute),
		kgo.RecordDeliveryTimeout(15 * time.Second), kgo.ProducerLinger(0),
		kgo.FetchMaxBytes(4 * 1024 * 1024), kgo.FetchMaxPartitionBytes(1024 * 1024)}
	client, err := makeBindingClient(append(options, security...)...)
	if err != nil {
		return nil, err
	}
	return &BindingKafka{client: client, topicPrefix: prefix}, nil
}

func (k *BindingKafka) Next(ctx context.Context) (BindingMessage, error) {
	k.client.AllowRebalance()
	for {
		fetches := k.client.PollRecords(ctx, 1)
		if err := k.fetchError(fetches); err != nil {
			return BindingMessage{}, err
		}
		records := fetches.Records()
		if len(records) == 0 {
			continue
		}
		record := records[0]
		canonical := strings.TrimPrefix(record.Topic, k.topicPrefix)
		if !strings.HasPrefix(record.Topic, k.topicPrefix) || (canonical != bindingTopic && canonical != sensorLayoutTopic) {
			return BindingMessage{}, fmt.Errorf("unexpected binding transport topic %q", record.Topic)
		}
		return BindingMessage{Topic: canonical, TransportTopic: record.Topic, Partition: record.Partition, Offset: record.Offset, Key: record.Key, Value: record.Value,
			Commit: func(ctx context.Context) error { return k.client.CommitRecords(ctx, record) }}, nil
	}
}

func (k *BindingKafka) PublishQuarantine(ctx context.Context, record BindingRecord) error {
	return k.client.ProduceSync(ctx, &kgo.Record{Topic: k.topicPrefix + record.Topic, Key: record.Key, Value: record.Value}).FirstErr()
}
func (k *BindingKafka) Close()                         { k.client.CloseAllowingRebalance() }
func (k *BindingKafka) Ping(ctx context.Context) error { return k.client.Ping(ctx) }

func (k *BindingKafka) fetchError(fetches kgo.Fetches) error {
	var lost error
	fetches.EachError(func(topic string, partition int32, err error) {
		if lost != nil || !errors.Is(err, kerr.OffsetOutOfRange) {
			return
		}
		offset := "unknown"
		if committed, ok := k.client.CommittedOffsets()[topic][partition]; ok {
			offset = fmt.Sprint(committed.Offset)
		}
		lost = fmt.Errorf("%w: topic=%s partition=%d committed_offset=%s: %w", errCommittedOffsetLost, topic, partition, offset, err)
	})
	if lost != nil {
		return lost
	}
	return fetches.Err()
}

var errCommittedOffsetLost = errors.New("committed binding offset is out of range; refusing to skip lost events; replay retained inventory outbox via a fresh Debezium connector and slot, then deliberately reset the affected consumer offsets; see docs/WAL_RETENTION.md")
