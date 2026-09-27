package main

import (
	"context"
	"errors"

	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
)

var errCommittedOffsetLost = errors.New("committed notification offset is out of range; refusing to skip invalidations; bump the global cache epoch and reset the group only after review")

// Kafka adapts the shared fail-closed transport to the batching Source seam.
type Kafka struct {
	client transport.Client
	transport.SharedOps
	// pending keeps the polled kgo records so commits use the exact fetched records.
	pending map[recordID]*kgo.Record
}

type recordID struct {
	topic     string
	partition int32
	offset    int64
}

var makeClient = func(options ...kgo.Opt) (transport.Client, error) { return kgo.NewClient(options...) }

func newKafka(brokers []string, group string) (*Kafka, error) {
	client, err := makeClient(transport.Options(brokers, group, []string{notificationTopic})...)
	if err != nil {
		return nil, err
	}
	return &Kafka{client: client, SharedOps: transport.SharedOps{Client: client}, pending: map[recordID]*kgo.Record{}}, nil
}

func (k *Kafka) Poll(ctx context.Context, max int) ([]Record, error) {
	fetches := k.client.PollRecords(ctx, max)
	if err := transport.FetchError(k.client, fetches, errCommittedOffsetLost); err != nil {
		// A window or epoch-retry deadline is an empty poll; shutdown and lost offsets fail.
		// A persistent fetch error reappears on the next poll.
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, nil
		}
		return nil, err
	}
	records := fetches.Records()
	out := make([]Record, 0, len(records))
	for _, r := range records {
		k.pending[recordID{r.Topic, r.Partition, r.Offset}] = r
		out = append(out, Record{Topic: r.Topic, Partition: r.Partition, Offset: r.Offset, Value: r.Value})
	}
	return out, nil
}

func (k *Kafka) Commit(ctx context.Context, records []Record) error {
	commit := make([]*kgo.Record, 0, len(records))
	for _, r := range records {
		if record, ok := k.pending[recordID{r.Topic, r.Partition, r.Offset}]; ok {
			commit = append(commit, record)
		}
	}
	if err := k.client.CommitRecords(ctx, commit...); err != nil {
		return err
	}
	for _, r := range records {
		delete(k.pending, recordID{r.Topic, r.Partition, r.Offset})
	}
	return nil
}

func (k *Kafka) AllowRebalance() { k.client.AllowRebalance() }
