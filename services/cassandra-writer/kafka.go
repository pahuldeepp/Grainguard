package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
	"os"
	"regexp"
	"strings"
)

const consumerGroup = "cassandra-writer"

var errCommittedOffsetLost = errors.New("committed telemetry offset is out of range; refusing to skip lost events; rebuild history from retained source (see docs/adr/0012-cassandra-history.md)")

type kafkaClient = transport.Client
type Kafka struct {
	client      kafkaClient
	topicPrefix string
	transport.SharedOps
}

var makeClient = func(options ...kgo.Opt) (kafkaClient, error) { return kgo.NewClient(options...) }

func newKafka(brokers []string, group string) (*Kafka, error) {
	return newKafkaWithPrefix(brokers, group, os.Getenv("KAFKA_TOPIC_PREFIX"))
}

func newKafkaWithPrefix(brokers []string, group, prefix string) (*Kafka, error) {
	if err := validateTopicPrefix(prefix); err != nil {
		return nil, err
	}
	options, err := transport.SecureOptions(brokers, group, []string{prefix + topicTelemetry, prefix + topicTelemetryV2})
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
	m, err := transport.NextMessage(ctx, k.client, errCommittedOffsetLost)
	if err != nil {
		return m, err
	}
	m.TransportTopic = m.Topic
	m.Topic = strings.TrimPrefix(m.Topic, k.topicPrefix)
	if !strings.HasPrefix(m.TransportTopic, k.topicPrefix) || (m.Topic != topicTelemetry && m.Topic != topicTelemetryV2) {
		return Message{}, fmt.Errorf("unexpected history transport topic %q", m.TransportTopic)
	}
	return m, nil
}

func validateTopicPrefix(prefix string) error {
	if prefix != "" && !regexp.MustCompile(`^[A-Za-z0-9._-]+$`).MatchString(prefix) {
		return errors.New("invalid KAFKA_TOPIC_PREFIX")
	}
	for _, topic := range []string{topicTelemetry, topicTelemetryV2, topicQuarantine} {
		if len(prefix+topic) > 249 {
			return errors.New("KAFKA_TOPIC_PREFIX exceeds Kafka topic limit")
		}
	}
	return nil
}

func (k *Kafka) Publish(ctx context.Context, record Record) error {
	record.Topic = k.topicPrefix + record.Topic
	return k.SharedOps.Publish(ctx, record)
}
