package main

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

const feedPrefix = "greenguard.binding-feed"
const feedKey = "binding-feed-checkpoint"
const feedPartitions = 6

// Transactional logical messages share the single raw inventory partition with
// outbox rows. Source ts_ms is commit time; the top-level connector clock is not.
func heartbeatRecords(m Message) ([]Record, bool) {
	value, err := decode(m.Value)
	if err != nil {
		return nil, false
	}
	envelope, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	if payload, ok := envelope[fieldPayload].(map[string]any); ok {
		envelope = payload
	}
	if envelope["op"] != "m" {
		return nil, false
	}
	source, _ := envelope["source"].(map[string]any)
	message, _ := envelope["message"].(map[string]any)
	if m.Topic != rawInventory || m.Partition != 0 || source["db"] != "greenguard_inventory" || message["prefix"] != feedPrefix {
		return nil, false
	}
	lsn, ok := positiveSourceNumber(source["lsn"])
	if !ok {
		return nil, false
	}
	if _, ok := positiveSourceNumber(source["txId"]); !ok {
		return nil, false
	}
	millis, ok := positiveSourceNumber(source["ts_ms"])
	if !ok {
		return nil, false
	}
	body, _ := json.Marshal(map[string]any{
		"event_type": "binding.feed_checkpoint", "schema_version": 1,
		"source_time":     time.UnixMilli(millis).UTC().Format(time.RFC3339Nano),
		"source_position": strconv.FormatInt(lsn, 10), "raw_position": m.Offset, "partitions": feedPartitions,
	})
	records := make([]Record, feedPartitions)
	for partition := range records {
		records[partition] = Record{Topic: topicInventory, Key: []byte(feedKey), Value: body, Headers: map[string]string{"binding_partition": strconv.Itoa(partition)}}
	}
	return records, true
}

func positiveSourceNumber(value any) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	n, err := number.Int64()
	return n, err == nil && n > 0
}

func (p *Processor) publishHeartbeat(ctx context.Context, m Message, records []Record) error {
	for _, record := range records {
		if err := p.retry(ctx, func(ctx context.Context) error { return p.publishAttempt(ctx, p.Sink.Publish, record) }); err != nil {
			return err
		}
	}
	return p.retry(ctx, m.Commit)
}

// Only internal checkpoint records select a partition explicitly. All domain
// keys retain the Kafka-compatible keyed hash and ordering behavior.
type feedPartitioner struct{}

func (feedPartitioner) ForTopic(topic string) kgo.TopicPartitioner {
	return feedTopicPartitioner{kgo.StickyKeyPartitioner(nil).ForTopic(topic)}
}

type feedTopicPartitioner struct{ kgo.TopicPartitioner }

func (p feedTopicPartitioner) Partition(record *kgo.Record, n int) int {
	for _, header := range record.Headers {
		if header.Key == "binding_partition" {
			partition, err := strconv.Atoi(string(header.Value))
			if err != nil || n != feedPartitions || partition < 0 || partition >= n {
				return -1
			}
			return partition
		}
	}
	return p.TopicPartitioner.Partition(record, n)
}
