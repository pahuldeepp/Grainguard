package main

import (
	"context"
	"errors"
	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
	"strings"
)

var errCommittedOffsetLost = errors.New("committed raw offset is out of range; refusing to skip lost events; replay retained outbox_events via a Debezium snapshot with a fresh connector name and slot; see docs/WAL_RETENTION.md")

type kafkaClient = transport.Client
type Kafka struct {
	client      kafkaClient
	topicPrefix string
	transport.SharedOps
}

var makeClient = func(options ...kgo.Opt) (kafkaClient, error) { return kgo.NewClient(options...) }

func newKafka(brokers []string, group string) (*Kafka, error) {
	return newKafkaWithPrefix(brokers, group, "")
}
func newKafkaWithPrefix(brokers []string, group, prefix string) (*Kafka, error) {
	topics := make([]string, len(projectionTopics))
	for i, topic := range projectionTopics {
		topics[i] = prefix + topic
		if len(topics[i]) > 249 || strings.IndexFunc(prefix, func(r rune) bool {
			return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-')
		}) >= 0 {
			return nil, errors.New("invalid KAFKA_TOPIC_PREFIX")
		}
	}
	options, err := transport.SecureOptions(brokers, group, topics)
	if err != nil {
		return nil, err
	}
	client, err := makeClient(options...)
	if err != nil {
		return nil, err
	}
	return &Kafka{client: client, topicPrefix: prefix, SharedOps: transport.SharedOps{Client: client}}, nil
}
func (k *Kafka) Next(ctx context.Context) (Message, error) {
	raw, err := transport.NextMessage(ctx, k.client, errCommittedOffsetLost)
	m := Message{EndOffset: raw.EndOffset, Topic: raw.Topic, TransportTopic: raw.Topic, Partition: raw.Partition, Offset: raw.Offset, Key: raw.Key, Value: raw.Value, Headers: raw.Headers, Commit: raw.Commit}
	if err == nil && k.topicPrefix != "" {
		if !strings.HasPrefix(m.Topic, k.topicPrefix) {
			return Message{}, errors.New("unexpected projection transport topic")
		}
		// NextMessage's commit closure retains the original Kafka record.
		m.Topic = strings.TrimPrefix(m.Topic, k.topicPrefix)
	}
	return m, err
}
func (k *Kafka) PublishQuarantine(ctx context.Context, record Record) error {
	record.Topic = k.topicPrefix + record.Topic
	return k.SharedOps.PublishQuarantine(ctx, record)
}
