package main

import (
	"context"
	"errors"
	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
)

const consumerGroup = "cassandra-writer"

var errCommittedOffsetLost = errors.New("committed telemetry offset is out of range; refusing to skip lost events; rebuild history from retained source (see docs/adr/0012-cassandra-history.md)")

type kafkaClient = transport.Client
type Kafka struct {
	client kafkaClient
	transport.SharedOps
}

var makeClient = func(options ...kgo.Opt) (kafkaClient, error) { return kgo.NewClient(options...) }

func newKafka(brokers []string, group string) (*Kafka, error) {
	client, err := makeClient(transport.Options(brokers, group, []string{topicTelemetry})...)
	if err != nil {
		return nil, err
	}
	return &Kafka{client: client, SharedOps: transport.SharedOps{Client: client}}, nil
}
func (k *Kafka) Next(ctx context.Context) (Message, error) {
	return transport.NextMessage(ctx, k.client, errCommittedOffsetLost)
}
