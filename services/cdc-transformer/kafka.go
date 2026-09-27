package main

import (
	"context"
	"errors"
	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
)

var errCommittedOffsetLost = errors.New("committed raw offset is out of range; refusing to skip lost events; replay retained outbox_events via a Debezium snapshot with a fresh connector name and slot; see docs/WAL_RETENTION.md")

type kafkaClient = transport.Client
type Kafka struct {
	client kafkaClient
	transport.SharedOps
}

var makeClient = func(options ...kgo.Opt) (kafkaClient, error) { return kgo.NewClient(options...) }

func newKafka(brokers []string, group string) (*Kafka, error) {
	options := transport.Options(brokers, group, []string{rawInventory, rawControl, rawBilling, rawTelemetry, rawRisk, rawAlerts, rawProjection}, kgo.RecordPartitioner(feedPartitioner{}))
	client, err := makeClient(options...)
	if err != nil {
		return nil, err
	}
	return &Kafka{client: client, SharedOps: transport.SharedOps{Client: client}}, nil
}
func (k *Kafka) Next(ctx context.Context) (Message, error) {
	record, _, err := transport.Next(ctx, k.client, errCommittedOffsetLost)
	if err != nil {
		return Message{}, err
	}
	return Message{Topic: record.Topic, Partition: record.Partition, Offset: record.Offset, Value: record.Value,
		Commit: func(ctx context.Context) error { return k.client.CommitRecords(ctx, record) }}, nil
}
func (k *Kafka) fetchError(fetches kgo.Fetches) error {
	return transport.FetchError(k.client, fetches, errCommittedOffsetLost)
}
