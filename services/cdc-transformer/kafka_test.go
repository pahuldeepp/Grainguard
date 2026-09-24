package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
)

type fakeKafka struct {
	polls     int
	committed bool
	closed    bool
}

func (f *fakeKafka) PollRecords(context.Context, int) kgo.Fetches {
	f.polls++
	if f.polls == 1 {
		return nil
	}
	return kgo.Fetches{{Topics: []kgo.FetchTopic{{Topic: rawTelemetry, Partitions: []kgo.FetchPartition{{Records: []*kgo.Record{{Topic: rawTelemetry, Offset: 4, Value: []byte("null")}}}}}}}}
}
func (f *fakeKafka) CommitRecords(context.Context, ...*kgo.Record) error {
	f.committed = true
	return nil
}
func (f *fakeKafka) ProduceSync(_ context.Context, rs ...*kgo.Record) kgo.ProduceResults {
	return kgo.ProduceResults{{Record: rs[0], Err: errTest}}
}
func (f *fakeKafka) AllowRebalance()            { f.polls = 0 }
func (f *fakeKafka) Ping(context.Context) error { return errTest }
func (f *fakeKafka) CloseAllowingRebalance()    { f.closed = true }

func TestKafkaAdapterSeams(t *testing.T) {
	old := makeClient
	t.Cleanup(func() { makeClient = old })
	makeClient = func(...kgo.Opt) (kafkaClient, error) { return nil, errTest }
	if _, err := newKafka(nil, ""); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	fake := &fakeKafka{}
	makeClient = func(...kgo.Opt) (kafkaClient, error) { return fake, nil }
	k, err := newKafka([]string{"localhost:9092"}, "test")
	if err != nil {
		t.Fatal(err)
	}
	m, err := k.Next(context.Background())
	if err != nil || m.Offset != 4 {
		t.Fatal(m, err)
	}
	if err := m.Commit(context.Background()); err != nil || !fake.committed {
		t.Fatal(err)
	}
	if err := k.PublishQuarantine(context.Background(), Record{Topic: topicQuarantine, Headers: map[string]string{"b": "2", "a": "1"}}); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	if err := k.Ping(context.Background()); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	k.Close()
	if !fake.closed {
		t.Fatal("not closed")
	}
}

type testCluster struct {
	*kfake.Cluster
	network *kfake.VirtualNetwork
}

func cluster(t *testing.T) *testCluster {
	t.Helper()
	network := new(kfake.VirtualNetwork)
	c, err := kfake.NewCluster(kfake.ListenFn(network.Listen), kfake.NumBrokers(1), kfake.SeedTopics(2, rawTelemetry, rawInventory, topicTelemetry, topicInventory, topicQuarantine))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return &testCluster{c, network}
}
func kafkaTestClient(t *testing.T, c *testCluster, options ...kgo.Opt) *kgo.Client {
	t.Helper()
	opts := append([]kgo.Opt{kgo.SeedBrokers(c.ListenAddrs()...), kgo.Dialer(c.network.DialContext)}, options...)
	client, err := kgo.NewClient(opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseAllowingRebalance)
	return client
}

func TestRealKafkaPathInProcess(t *testing.T) {
	c := cluster(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	writer := kafkaTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	raw := rawEvent(t, validEvent(t))
	for _, value := range [][]byte{raw, []byte("{"), raw} {
		if err := writer.ProduceSync(ctx, &kgo.Record{Topic: rawTelemetry, Partition: 0, Value: value}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	var wireChecks atomic.Int64
	checkPublicationWire(t, c, &wireChecks)
	oldFactory := makeClient
	makeClient = func(options ...kgo.Opt) (kafkaClient, error) {
		return oldFactory(append(options, kgo.Dialer(c.network.DialContext))...)
	}
	t.Cleanup(func() { makeClient = oldFactory })
	adapter, err := newKafka(c.ListenAddrs(), "test-real-path")
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	if err := adapter.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	p := testProcessor(t)
	p.Sink = adapter
	processKafkaRecords(t, ctx, adapter, p)
	assertKafkaPublications(t, ctx, c)
	if wireChecks.Load() != 3 {
		t.Fatalf("expected 3 acknowledged publication batches, got %d", wireChecks.Load())
	}
	// Query the broker's committed frontier, not merely an invocation count.
	req := kmsg.NewPtrOffsetFetchRequest()
	req.Group = "test-real-path"
	req.Topics = []kmsg.OffsetFetchRequestTopic{{Topic: rawTelemetry, Partitions: []int32{0}}}
	response, err := req.RequestWith(ctx, writer)
	if err != nil {
		t.Fatal(err)
	}
	if response.Topics[0].Partitions[0].Offset != 3 {
		t.Fatalf("frontier: %+v", response)
	}
	cancelled, stop := context.WithCancel(ctx)
	stop()
	if _, err := adapter.Next(cancelled); err == nil {
		t.Fatal("cancelled poll succeeded")
	}
}

func (f *fakeKafka) CommittedOffsets() map[string]map[int32]kgo.EpochOffset {
	return nil
}

func checkPublicationWire(t *testing.T, c *testCluster, wireChecks *atomic.Int64) {
	t.Helper()
	c.ControlKey(0, func(request kmsg.Request) (kmsg.Response, error, bool) {
		c.KeepControl()
		produce := request.(*kmsg.ProduceRequest)
		if produce.Acks != -1 {
			t.Error("producer did not request all ISR acknowledgements")
		}
		for _, topic := range produce.Topics {
			for _, partition := range topic.Partitions {
				assertIdempotentBatch(t, partition.Records)
				wireChecks.Add(1)
			}
		}
		return nil, nil, false
	})
}

func processKafkaRecords(t *testing.T, ctx context.Context, adapter *Kafka, p *Processor) {
	t.Helper()
	for i := 0; i < 3; i++ {
		m, err := adapter.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if m.Offset != int64(i) {
			t.Fatalf("offset %d", m.Offset)
		}
		if err := p.process(ctx, m); err != nil {
			t.Fatal(err)
		}
	}
}

func assertKafkaPublications(t *testing.T, ctx context.Context, c *testCluster) {
	t.Helper()
	reader := kafkaTestClient(t, c, kgo.ConsumeTopics(topicTelemetry, topicQuarantine), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	var canonical [][]byte
	quarantined := 0
	for len(canonical)+quarantined < 3 {
		fetched := reader.PollRecords(ctx, 3)
		if err := fetched.Err(); err != nil {
			t.Fatal(err)
		}
		for _, r := range fetched.Records() {
			if r.Topic == topicQuarantine {
				quarantined++
				continue
			}
			canonical = append(canonical, r.Value)
			if string(r.Key) != validEvent(t)[fieldTenant].(string)+":"+validEvent(t)[fieldAggregate].(string) || len(r.Headers) != 6 {
				t.Fatal("key or headers lost")
			}
		}
	}
	if string(canonical[0]) != string(canonical[1]) {
		t.Fatal("duplicate bytes differ")
	}
}

func assertIdempotentBatch(t *testing.T, records []byte) {
	t.Helper()
	var batch kmsg.RecordBatch
	if err := batch.ReadFrom(records); err != nil {
		t.Error(err)
	}
	if batch.ProducerID < 0 || batch.FirstSequence < 0 {
		t.Error("producer idempotence is disabled")
	}
}

func TestLotSemanticRejectionsBeforePublication(t *testing.T) {
	schemas := testSchemas(t)
	for _, field := range []string{"site_id", "lot_id", "previous_lot_id"} {
		t.Run(field, func(t *testing.T) {
			event := eventFixture(t, "lot-changed.v1.valid.json")
			event[fieldPayload].(map[string]any)[field] = "00000000-0000-0000-0000-000000000000"
			_, _, err := transform(Message{Topic: rawInventory, Value: rawEvent(t, event)}, schemas)
			requireReason(t, err, reasonSchema)
			if err.Detail != field+" must not be nil UUID" {
				t.Fatal(err)
			}
		})
	}
	t.Run("unchanged lot", func(t *testing.T) {
		event := eventFixture(t, "lot-changed.v1.valid.json")
		payload := event[fieldPayload].(map[string]any)
		payload["previous_lot_id"] = payload["lot_id"]
		_, _, err := transform(Message{Topic: rawInventory, Value: rawEvent(t, event)}, schemas)
		requireReason(t, err, reasonSchema)
		if err.Detail != "lot_id must differ from previous_lot_id" {
			t.Fatal(err)
		}
	})
}
