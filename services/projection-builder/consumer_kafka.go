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
	client, err := makeClient(transport.Options(brokers, group, []string{topicInventory, topicTelemetry})...)
	if err != nil {
		return nil, err
	}
	return &Kafka{client: client, SharedOps: transport.SharedOps{Client: client}}, nil
}
func (k *Kafka) Next(ctx context.Context) (Message, error) {
	return transport.NextMessage(ctx, k.client, errCommittedOffsetLost)
}
