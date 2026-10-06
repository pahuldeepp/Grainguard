package main

import (
	"context"
	"errors"
	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
	"regexp"
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
	if prefix != "" && !regexp.MustCompile(`^[a-zA-Z0-9_-]+[.]$`).MatchString(prefix) {
		return nil, errors.New("KAFKA_TOPIC_PREFIX must be a topic namespace ending in a dot")
	}
	// Validate produced names too: the longest canonical topic can exceed the
	// Kafka limit even when every raw subscription would fit.
	for _, topic := range []string{rawInventory, rawControl, rawBilling, rawTelemetry, rawRisk, rawAlerts, rawProjection, topicSensorLayout, topicFacility, topicLot, topicProjection, topicTelemetry, topicTelemetryV2, topicInventory, topicTenant, topicBilling, topicPlatformConfig, topicRisk, topicRiskV2, topicRiskPolicy, topicRiskInvalidated, topicAlerts, topicQuarantine} {
		if len(prefix+topic) > 249 {
			return nil, errors.New("KAFKA_TOPIC_PREFIX produces a topic name longer than 249 bytes")
		}
	}
	topics := []string{rawInventory, rawControl, rawBilling, rawTelemetry, rawRisk, rawAlerts, rawProjection}
	for i := range topics {
		topics[i] = prefix + topics[i]
	}
	options, err := transport.SecureOptions(brokers, group, topics, kgo.RecordPartitioner(feedPartitioner{}))
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
	record, _, err := transport.Next(ctx, k.client, errCommittedOffsetLost)
	if err != nil {
		return Message{}, err
	}
	return Message{Topic: strings.TrimPrefix(record.Topic, k.topicPrefix), TransportTopic: record.Topic, Partition: record.Partition, Offset: record.Offset, Value: record.Value,
		Commit: func(ctx context.Context) error { return k.client.CommitRecords(ctx, record) }}, nil
}
func (k *Kafka) fetchError(fetches kgo.Fetches) error {
	return transport.FetchError(k.client, fetches, errCommittedOffsetLost)
}

// Topic names belong to the transport namespace; event validation retains the
// canonical contracts. Commits always refer to the original transport record.
func (k *Kafka) Publish(ctx context.Context, record Record) error {
	record.Topic = k.topicPrefix + record.Topic
	return k.SharedOps.Publish(ctx, record)
}
func (k *Kafka) PublishQuarantine(ctx context.Context, record Record) error {
	record.Topic = k.topicPrefix + record.Topic
	return k.SharedOps.PublishQuarantine(ctx, record)
}
