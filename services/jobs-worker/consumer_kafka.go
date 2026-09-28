package main

import (
	"context"
	"errors"
	"os"

	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
)

// kafkaSource is the franz-go adapter. It should move to packages/kafka-transport once that
// shared transport stabilises; it is deliberately small until then.
type kafkaSource struct {
	client *kgo.Client
}

func newKafkaSource(brokers []string, group, topic string) (*kafkaSource, error) {
	security, err := transport.SecurityOptions(os.Getenv)
	if err != nil {
		return nil, err
	}
	options := append([]kgo.Opt{
		kgo.SeedBrokers(brokers...),
		kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topic),
		kgo.DisableAutoCommit(),
		kgo.FetchIsolationLevel(kgo.ReadCommitted()),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	}, security...)
	client, err := kgo.NewClient(options...)
	if err != nil {
		return nil, err
	}
	return &kafkaSource{client: client}, nil
}

func (k *kafkaSource) Poll(ctx context.Context) ([]Record, error) {
	fetches := k.client.PollRecords(ctx, 100)
	var errs []error
	fetches.EachError(func(_ string, _ int32, err error) {
		if !errors.Is(err, context.Canceled) {
			errs = append(errs, err)
		}
	})
	var out []Record
	fetches.EachRecord(func(r *kgo.Record) {
		out = append(out, Record{Topic: r.Topic, Partition: r.Partition, Offset: r.Offset, Value: r.Value})
	})
	return out, errors.Join(errs...)
}

func (k *kafkaSource) Commit(ctx context.Context, records []Record) error {
	krs := make([]*kgo.Record, 0, len(records))
	for _, r := range records {
		krs = append(krs, &kgo.Record{Topic: r.Topic, Partition: r.Partition, Offset: r.Offset})
	}
	return k.client.CommitRecords(ctx, krs...)
}

func (k *kafkaSource) Close() { k.client.Close() }
