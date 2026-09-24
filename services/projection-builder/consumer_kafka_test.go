package main

import (
	"context"
	"errors"

	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kmsg"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
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
	return kgo.Fetches{{Topics: []kgo.FetchTopic{{Topic: topicTelemetry, Partitions: []kgo.FetchPartition{{Records: []*kgo.Record{{Topic: topicTelemetry, Offset: 4, Value: []byte("null")}}}}}}}}
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
	c, err := kfake.NewCluster(kfake.ListenFn(network.Listen), kfake.NumBrokers(1), kfake.SeedTopics(2, topicTelemetry, topicInventory, topicQuarantine))
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

func (f *fakeKafka) CommittedOffsets() map[string]map[int32]kgo.EpochOffset { return nil }
func TestKafkaFatalOffset(t *testing.T) {
	k := &Kafka{client: &fakeKafka{}}
	for _, e := range []error{kerr.OffsetOutOfRange, errTest} {
		f := kgo.Fetches{{Topics: []kgo.FetchTopic{{Topic: topicInventory, Partitions: []kgo.FetchPartition{{Partition: 2, Err: e}}}}}}
		err := transport.FetchError(k.client, f, errCommittedOffsetLost)
		if e == kerr.OffsetOutOfRange && !errors.Is(err, errCommittedOffsetLost) {
			t.Fatal(err)
		}
		if e == errTest && !errors.Is(err, errTest) {
			t.Fatal(err)
		}
	}
}
func TestKafkaPoisonGoodFrontier(t *testing.T) {
	c := cluster(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	old := makeClient
	makeClient = func(opts ...kgo.Opt) (kafkaClient, error) {
		return old(append(opts, kgo.Dialer(c.network.DialContext))...)
	}
	t.Cleanup(func() { makeClient = old })
	writer := kafkaTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	m := message(validEvent(t))
	for _, value := range [][]byte{[]byte("bad"), m.Value, m.Value} {
		if err := writer.ProduceSync(ctx, &kgo.Record{Topic: m.Topic, Partition: 0, Key: m.Key, Value: value, Headers: m.Headers}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	k, err := newKafka(c.ListenAddrs(), "projection-test")
	if err != nil {
		t.Fatal(err)
	}
	defer k.Close()
	if err = k.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	p := testProcessor(t)
	p.Sink = k
	applied := false
	p.Apply = func(context.Context, Message, map[string]any) error {
		if applied {
			return ErrDuplicate
		}
		applied = true
		return nil
	}
	for i := 0; i < 3; i++ {
		msg, err := k.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err = p.process(ctx, msg); err != nil {
			t.Fatal(err)
		}
	}
	req := kmsg.NewPtrOffsetFetchRequest()
	req.Group = "projection-test"
	req.Topics = []kmsg.OffsetFetchRequestTopic{{Topic: m.Topic, Partitions: []int32{0}}}
	res, err := req.RequestWith(ctx, writer)
	if err != nil {
		t.Fatal(err)
	}
	if res.Topics[0].Partitions[0].Offset != 3 || p.Applied.Load() != 1 || p.Duplicates.Load() != 1 {
		t.Fatal(res)
	}
	reader := kafkaTestClient(t, c, kgo.ConsumeTopics(topicQuarantine), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	records := reader.PollRecords(ctx, 1)
	if records.Err() != nil || len(records.Records()) != 1 {
		t.Fatal(records.Err())
	}
	r := records.Records()[0]
	if len(r.Headers) != 1 || string(r.Headers[0].Value) != "unknown" {
		t.Fatal(r.Headers)
	}
	cancel()
	if _, err = k.Next(ctx); err == nil {
		t.Fatal("cancelled poll")
	}
}

func TestKafkaRestartAfterEffectBeforeOffset(t *testing.T) {
	c := cluster(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	old := makeClient
	makeClient = func(opts ...kgo.Opt) (kafkaClient, error) {
		return old(append(opts, kgo.Dialer(c.network.DialContext))...)
	}
	t.Cleanup(func() { makeClient = old })
	writer := kafkaTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	m := message(validEvent(t))
	for i := 0; i < 2; i++ {
		if err := writer.ProduceSync(ctx, &kgo.Record{Topic: m.Topic, Partition: 0, Key: m.Key, Value: m.Value, Headers: m.Headers}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	first, err := newKafka(c.ListenAddrs(), "restart-test")
	if err != nil {
		t.Fatal(err)
	}
	incoming, err := first.Next(ctx)
	if err != nil {
		first.Close()
		t.Fatal(err)
	}
	p := testProcessor(t)
	effects := 0
	p.Apply = func(context.Context, Message, map[string]any) error {
		if effects > 0 {
			return ErrDuplicate
		}
		effects++
		return nil
	}
	incoming.Commit = func(context.Context) error { return errTest }
	if err = p.process(ctx, incoming); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	first.Close()
	second, err := newKafka(c.ListenAddrs(), "restart-test")
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	replay, err := second.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if replay.Offset != incoming.Offset {
		t.Fatal("skipped unfinished frontier", replay.Offset, incoming.Offset)
	}
	if err = p.process(ctx, replay); err != nil || effects != 1 || p.Duplicates.Load() != 1 {
		t.Fatal(err, effects)
	}
}
