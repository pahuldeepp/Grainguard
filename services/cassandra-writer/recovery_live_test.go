package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
	"greenguard.local/cassandra-writer/history"
)

// This opt-in test needs the local Kafka and Cassandra overlays and their
// migrations. It uses a fresh group and UUIDs, so it leaves existing groups
// and history untouched.
func TestLiveKafkaCassandraCrashReplay(t *testing.T) {
	if os.Getenv("KAFKA_CASSANDRA_LIVE") != "1" {
		t.Skip("set KAFKA_CASSANDRA_LIVE=1 with local Kafka and Cassandra running")
	}
	if os.Getenv("CASSANDRA_RECOVERY_CHILD") == "1" {
		runCrashChild(t)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	brokers := strings.Split(os.Getenv("KAFKA_BROKERS"), ",")
	if brokers[0] == "" {
		brokers = []string{"127.0.0.1:59092"}
	}
	admin, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.RecordPartitioner(kgo.ManualPartitioner()), kgo.RequiredAcks(kgo.AllISRAcks()))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if err := admin.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	group := "cassandra-recovery-" + uuid()
	baseline := topicEnds(t, ctx, admin, topicTelemetry)
	commitBaseline(t, ctx, admin, group, baseline)
	quarantineStart := topicEnds(t, ctx, admin, topicQuarantine)[0]

	event, tenant, device, reading := recoveryEvent(t)
	valid := &kgo.Record{Topic: topicTelemetry, Partition: 0, Key: []byte(tenant + ":" + device), Value: event,
		Headers: []kgo.RecordHeader{{Key: fieldTenant, Value: []byte(tenant)}, {Key: fieldEvent, Value: []byte(reading.event)}, {Key: fieldType, Value: []byte(typeTelemetry)}, {Key: fieldSchema, Value: []byte("1")}}}
	poison := &kgo.Record{Topic: topicTelemetry, Partition: 0, Key: valid.Key, Value: []byte("{")}
	produceRecoveryRecords(t, ctx, admin, baseline, valid, poison)

	crashConfirmedWorker(t, ctx, brokers, group, tenant, device)
	if got := committedOffset(t, ctx, admin, group, 0); got != valid.Offset {
		t.Fatalf("crash advanced Kafka offset to %d, want %d", got, valid.Offset)
	}

	cfg, err := history.LoadConfig(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	session, err := history.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	store := &history.Store{Session: session, TTL: 24 * time.Hour, MaxRows: 10, MaxDays: 2}
	assertBeforeReplay(t, ctx, store, tenant, device, reading, valid)

	consumer, err := newKafka(brokers, group)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	schema, err := loadSchema("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	p := &Processor{Source: consumer, Sink: consumer, Schema: schema, Store: store, Transient: history.Transient, Rejected: history.Rejected, Attempts: 5, RetryDelay: 50 * time.Millisecond, ProcessTimeout: 20 * time.Second}
	processReplay(t, ctx, consumer, p, valid, poison)
	if got := committedOffset(t, ctx, admin, group, 0); got != poison.Offset+1 {
		t.Fatalf("committed offset %d, want %d", got, poison.Offset+1)
	}
	if p.Written.Load() != 1 || p.Quarantined.Load() != 1 {
		t.Fatalf("replay effects: written=%d quarantined=%d", p.Written.Load(), p.Quarantined.Load())
	}
	mark := assertAfterReplay(t, ctx, store, tenant, device, reading, valid)
	assertQuarantine(t, ctx, brokers, quarantineStart, poison)
	t.Logf("crash/replay passed: group=%s source=%d,%d committed=%d row=%s watermark=%d", group, valid.Offset, poison.Offset, poison.Offset+1, reading.id, mark.Offset)
}

type recoveryReading struct {
	id, event string
	observed  time.Time
}

func recoveryEvent(t *testing.T) ([]byte, string, string, recoveryReading) {
	t.Helper()
	raw, err := os.ReadFile("../../tests/fixtures/events/telemetry-recorded.v1.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	var e map[string]any
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatal(err)
	}
	tenant, device, readingID, eventID := uuid(), uuid(), uuid(), uuid()
	e[fieldTenant], e[fieldAggregate], e[fieldEvent] = tenant, device, eventID
	payload := e[fieldPayload].(map[string]any)
	payload[fieldDevice], payload["reading_id"], payload["site_id"], payload["bin_id"] = device, readingID, uuid(), uuid()
	now := time.Now().UTC().Truncate(time.Millisecond)
	payload["observed_at"], payload["received_at"], e["occurred_at"] = now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)
	raw, err = json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	return raw, tenant, device, recoveryReading{readingID, eventID, now}
}

func uuid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

type blockingWriter struct {
	*history.Store
	tenant, device string
}

func (w blockingWriter) Confirm(ctx context.Context, mark history.Watermark) error {
	if err := w.Store.Confirm(ctx, mark); err != nil {
		return err
	}
	if mark.TenantID == w.tenant && mark.DeviceID == w.device {
		fmt.Println("CASSANDRA_CONFIRMED")
		time.Sleep(10 * time.Minute)
	}
	return nil
}

func runCrashChild(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cfg, err := history.LoadConfig(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	session, err := history.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	consumer, err := newKafka(strings.Split(os.Getenv("KAFKA_BROKERS"), ","), os.Getenv("CASSANDRA_RECOVERY_GROUP"))
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	schema, err := loadSchema("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	p := &Processor{Source: consumer, Sink: consumer, Schema: schema, Store: blockingWriter{&history.Store{Session: session, TTL: 24 * time.Hour}, os.Getenv("CASSANDRA_RECOVERY_TENANT"), os.Getenv("CASSANDRA_RECOVERY_DEVICE")}, Transient: history.Transient, Rejected: history.Rejected, Attempts: 5, RetryDelay: 50 * time.Millisecond, ProcessTimeout: 20 * time.Second}
	if err := p.Run(ctx); err != nil {
		t.Fatal(err)
	}
}

func topicEnds(t *testing.T, ctx context.Context, client *kgo.Client, topic string) map[int32]int64 {
	t.Helper()
	metadata := kmsg.NewPtrMetadataRequest()
	metadata.Topics = []kmsg.MetadataRequestTopic{{Topic: &topic}}
	info, err := metadata.RequestWith(ctx, client)
	if err != nil || len(info.Topics) != 1 || info.Topics[0].ErrorCode != 0 {
		t.Fatalf("topic metadata %s: %+v err=%v", topic, info, err)
	}
	req := kmsg.NewPtrListOffsetsRequest()
	entry := kmsg.ListOffsetsRequestTopic{Topic: topic}
	for _, p := range info.Topics[0].Partitions {
		part := kmsg.NewListOffsetsRequestTopicPartition()
		part.Partition, part.Timestamp = p.Partition, -1
		entry.Partitions = append(entry.Partitions, part)
	}
	req.Topics = []kmsg.ListOffsetsRequestTopic{entry}
	ends := map[int32]int64{}
	for _, shard := range client.RequestSharded(ctx, req) {
		if shard.Err != nil {
			t.Fatal(shard.Err)
		}
		collectEndOffsets(t, shard.Resp.(*kmsg.ListOffsetsResponse), ends)
	}
	if len(ends) != len(info.Topics[0].Partitions) {
		t.Fatalf("incomplete end offsets for %s: %+v", topic, ends)
	}
	return ends
}

func commitBaseline(t *testing.T, ctx context.Context, client *kgo.Client, group string, offsets map[int32]int64) {
	t.Helper()
	req := kmsg.NewPtrOffsetCommitRequest()
	req.Group = group
	topic := kmsg.OffsetCommitRequestTopic{Topic: topicTelemetry}
	for partition, offset := range offsets {
		part := kmsg.NewOffsetCommitRequestTopicPartition()
		part.Partition, part.Offset = partition, offset
		topic.Partitions = append(topic.Partitions, part)
	}
	req.Topics = []kmsg.OffsetCommitRequestTopic{topic}
	res, err := req.RequestWith(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	for _, topic := range res.Topics {
		for _, p := range topic.Partitions {
			if err := kerr.ErrorForCode(p.ErrorCode); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func committedOffset(t *testing.T, ctx context.Context, client *kgo.Client, group string, partition int32) int64 {
	t.Helper()
	req := kmsg.NewPtrOffsetFetchRequest()
	req.Group = group
	req.Topics = []kmsg.OffsetFetchRequestTopic{{Topic: topicTelemetry, Partitions: []int32{partition}}}
	res, err := req.RequestWith(ctx, client)
	if err != nil || len(res.Topics) != 1 || len(res.Topics[0].Partitions) != 1 {
		t.Fatalf("offset fetch: %+v err=%v", res, err)
	}
	p := res.Topics[0].Partitions[0]
	if err := kerr.ErrorForCode(p.ErrorCode); err != nil {
		t.Fatal(err)
	}
	return p.Offset
}

func assertQuarantine(t *testing.T, ctx context.Context, brokers []string, start int64, source *kgo.Record) {
	t.Helper()
	reader, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{topicQuarantine: {0: kgo.NewOffset().At(start)}}))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	for {
		fetches := reader.PollRecords(ctx, 1)
		if err := fetches.Err(); err != nil {
			t.Fatal(err)
		}
		for _, record := range fetches.Records() {
			var body struct {
				Reason    string `json:"reason"`
				Topic     string `json:"source_topic"`
				Partition int32  `json:"source_partition"`
				Offset    int64  `json:"source_offset"`
				Raw       []byte `json:"raw_base64"`
				Truncated bool   `json:"truncated"`
			}
			if err := json.Unmarshal(record.Value, &body); err != nil {
				t.Fatal(err)
			}
			if body.Topic == source.Topic && body.Partition == source.Partition && body.Offset == source.Offset {
				if body.Reason != reasonEnvelope || !bytes.Equal(body.Raw, source.Value) || body.Truncated {
					t.Fatalf("poison quarantine does not preserve source: reason=%q raw=%q truncated=%v", body.Reason, body.Raw, body.Truncated)
				}
				return
			}
		}
	}
}

func crashConfirmedWorker(t *testing.T, ctx context.Context, brokers []string, group, tenant, device string) {
	t.Helper()
	// The helper is a real OS process. Its Writer blocks only after Cassandra
	// has acknowledged both the row and watermark, before Kafka commit.
	child := exec.Command(os.Args[0], "-test.run=^TestLiveKafkaCassandraCrashReplay$")
	child.Env = append(os.Environ(), "KAFKA_CASSANDRA_LIVE=1", "CASSANDRA_RECOVERY_CHILD=1", "CASSANDRA_RECOVERY_GROUP="+group, "CASSANDRA_RECOVERY_TENANT="+tenant, "CASSANDRA_RECOVERY_DEVICE="+device, "KAFKA_BROKERS="+strings.Join(brokers, ","))
	pipe, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	child.Stderr = &stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	confirmed := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(pipe)
		for scanner.Scan() {
			if scanner.Text() == "CASSANDRA_CONFIRMED" {
				confirmed <- nil
				return
			}
		}
		confirmed <- fmt.Errorf("child ended before confirmation: %v", scanner.Err())
	}()
	select {
	case err := <-confirmed:
		if err != nil {
			_ = child.Process.Kill()
			_ = child.Wait()
			t.Fatalf("%v; stderr: %s", err, stderr.String())
		}
	case <-ctx.Done():
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatal(ctx.Err())
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
}

func assertBeforeReplay(t *testing.T, ctx context.Context, store *history.Store, tenant, device string, reading recoveryReading, valid *kgo.Record) {
	t.Helper()
	mark, found, err := store.ReadWatermark(ctx, tenant, device, topicTelemetry, 0)
	if err != nil || !found || mark.Offset != valid.Offset {
		t.Fatalf("confirmed watermark before replay: %+v found=%v err=%v", mark, found, err)
	}
	before, err := store.Query(ctx, tenant, device, reading.observed.Add(-time.Second), reading.observed.Add(time.Second))
	if err != nil || len(before.Readings) != 1 || before.Readings[0].ReadingID != reading.id {
		t.Fatalf("row before replay: %+v err=%v", before, err)
	}
}

func processReplay(t *testing.T, ctx context.Context, consumer *Kafka, p *Processor, valid, poison *kgo.Record) {
	t.Helper()
	for _, want := range []int64{valid.Offset, poison.Offset} {
		m, err := consumer.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if m.Partition != 0 || m.Offset != want {
			t.Fatalf("replay order: got partition %d offset %d, want 0/%d", m.Partition, m.Offset, want)
		}
		if err := p.process(ctx, m); err != nil {
			t.Fatal(err)
		}
	}
}

func assertAfterReplay(t *testing.T, ctx context.Context, store *history.Store, tenant, device string, reading recoveryReading, valid *kgo.Record) history.Watermark {
	t.Helper()
	mark, found, err := store.ReadWatermark(ctx, tenant, device, topicTelemetry, 0)
	if err != nil || !found || mark.Offset != valid.Offset {
		t.Fatalf("watermark after poison: %+v found=%v err=%v", mark, found, err)
	}
	result, err := store.Query(ctx, tenant, device, reading.observed.Add(-time.Second), reading.observed.Add(time.Second))
	if err != nil || len(result.Readings) != 1 || result.Readings[0].ReadingID != reading.id {
		t.Fatalf("idempotent row: %+v err=%v", result, err)
	}
	other, err := store.Query(ctx, uuid(), device, reading.observed.Add(-time.Second), reading.observed.Add(time.Second))
	if err != nil || len(other.Readings) != 0 {
		t.Fatalf("cross-tenant row visible: %+v err=%v", other, err)
	}
	return mark
}

func collectEndOffsets(t *testing.T, res *kmsg.ListOffsetsResponse, ends map[int32]int64) {
	t.Helper()
	for _, topic := range res.Topics {
		for _, p := range topic.Partitions {
			if err := kerr.ErrorForCode(p.ErrorCode); err != nil {
				t.Fatal(err)
			}
			ends[p.Partition] = p.Offset
		}
	}
}

func produceRecoveryRecords(t *testing.T, ctx context.Context, admin *kgo.Client, baseline map[int32]int64, valid, poison *kgo.Record) {
	t.Helper()
	if err := admin.ProduceSync(ctx, valid, poison).FirstErr(); err != nil {
		t.Fatal(err)
	}
	if valid.Offset != baseline[0] || poison.Offset != valid.Offset+1 {
		t.Fatalf("unexpected source offsets: baseline=%d valid=%d poison=%d", baseline[0], valid.Offset, poison.Offset)
	}
}
