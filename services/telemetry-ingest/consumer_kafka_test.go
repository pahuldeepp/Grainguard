package main

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
)

type fakeBindingKafka struct {
	polls     int
	committed bool
	closed    bool
}

func (f *fakeBindingKafka) PollRecords(context.Context, int) kgo.Fetches {
	f.polls++
	if f.polls == 1 {
		return nil
	}
	return kgo.Fetches{{Topics: []kgo.FetchTopic{{Topic: bindingTopic, Partitions: []kgo.FetchPartition{{Records: []*kgo.Record{{Topic: bindingTopic, Offset: 4, Value: []byte("null")}}}}}}}}
}
func (f *fakeBindingKafka) CommitRecords(context.Context, ...*kgo.Record) error {
	f.committed = true
	return nil
}
func (f *fakeBindingKafka) ProduceSync(_ context.Context, rs ...*kgo.Record) kgo.ProduceResults {
	return kgo.ProduceResults{{Record: rs[0], Err: errBoom}}
}
func (f *fakeBindingKafka) AllowRebalance()            { f.polls = 0 }
func (f *fakeBindingKafka) Ping(context.Context) error { return errBoom }
func (f *fakeBindingKafka) CloseAllowingRebalance()    { f.closed = true }

func TestBindingKafkaAdapterSeams(t *testing.T) {
	old := makeBindingClient
	t.Cleanup(func() { makeBindingClient = old })
	makeBindingClient = func(...kgo.Opt) (bindingKafkaClient, error) { return nil, errBoom }
	if _, err := newBindingKafka(nil, ""); !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
	fake := &fakeBindingKafka{}
	makeBindingClient = func(...kgo.Opt) (bindingKafkaClient, error) { return fake, nil }
	k, err := newBindingKafka([]string{"localhost:9092"}, "test")
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
	if err := k.PublishQuarantine(context.Background(), BindingRecord{Topic: quarantineTopic}); !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
	if err := k.Ping(context.Background()); !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
	k.Close()
	if !fake.closed {
		t.Fatal("not closed")
	}
}

func TestBindingKafkaRequiresTLSCredentialsWhenEnabled(t *testing.T) {
	t.Setenv("KAFKA_REQUIRE_TLS", "true")
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "")
	t.Setenv("KAFKA_SASL_MECHANISM", "")
	t.Setenv("KAFKA_SASL_USERNAME", "")
	t.Setenv("KAFKA_SASL_PASSWORD", "")
	t.Setenv("KAFKA_TLS_CA_FILE", "")
	if _, err := newBindingKafka([]string{"localhost:9092"}, "test"); err == nil {
		t.Fatal("binding Kafka client accepted missing TLS credentials")
	}
}

type bindingTestCluster struct {
	*kfake.Cluster
	network *kfake.VirtualNetwork
}

func bindingCluster(t *testing.T) *bindingTestCluster {
	t.Helper()
	network := new(kfake.VirtualNetwork)
	c, err := kfake.NewCluster(kfake.ListenFn(network.Listen), kfake.NumBrokers(1), kfake.SeedTopics(1, bindingTopic, quarantineTopic))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return &bindingTestCluster{c, network}
}
func bindingTestClient(t *testing.T, c *bindingTestCluster, options ...kgo.Opt) *kgo.Client {
	t.Helper()
	opts := append([]kgo.Opt{kgo.SeedBrokers(c.ListenAddrs()...), kgo.Dialer(c.network.DialContext)}, options...)
	client, err := kgo.NewClient(opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseAllowingRebalance)
	return client
}

// applyOnce records one effect per distinct payload and reports later copies as duplicates.
func applyOnce(t *testing.T, want []byte, applications *int) func(context.Context, []byte) (BindingOutcome, error) {
	effects := map[string]bool{}
	return func(_ context.Context, b []byte) (BindingOutcome, error) {
		if !bytes.Equal(b, want) {
			t.Fatal("bytes changed")
		}
		if effects[string(b)] {
			return BindingDuplicate, nil
		}
		effects[string(b)] = true
		*applications++
		return BindingApplied, nil
	}
}

// crashBeforeSecondCommit processes the poison record, then applies the next one
// but fails its offset commit, as a crash between effect and commit would.
func crashBeforeSecondCommit(ctx context.Context, t *testing.T, adapter *BindingKafka, consumer *BindingConsumer) {
	first, err := adapter.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := consumer.process(ctx, first); err != nil {
		t.Fatal(err)
	}
	second, err := adapter.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	second.Commit = func(context.Context) error { return context.Canceled }
	if err := consumer.process(ctx, second); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func drainFrom(ctx context.Context, t *testing.T, adapter *BindingKafka, consumer *BindingConsumer, from, to int64) {
	for i := from; i < to; i++ {
		next, err := adapter.Next(ctx)
		if err != nil || next.Offset != i {
			t.Fatal(next, err)
		}
		if err := consumer.process(ctx, next); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBindingKafkaPoisonThenGoodAndRestartFrontier(t *testing.T) {
	cluster := bindingCluster(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	writer := bindingTestClient(t, cluster, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	consumer, m := consumerFixture(t)
	for _, body := range [][]byte{[]byte("{"), m.Value, m.Value} {
		if err := writer.ProduceSync(ctx, &kgo.Record{Topic: bindingTopic, Partition: 0, Key: m.Key, Value: body}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	old := makeBindingClient
	makeBindingClient = func(opts ...kgo.Opt) (bindingKafkaClient, error) {
		return old(append(opts, kgo.Dialer(cluster.network.DialContext))...)
	}
	t.Cleanup(func() { makeBindingClient = old })
	adapter, err := newBindingKafka(cluster.ListenAddrs(), bindingGroup)
	if err != nil {
		t.Fatal(err)
	}
	if err := adapter.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	applications := 0
	consumer.Apply = applyOnce(t, m.Value, &applications)
	consumer.Sink = adapter
	crashBeforeSecondCommit(ctx, t, adapter, consumer)
	adapter.Close()
	adapter, err = newBindingKafka(cluster.ListenAddrs(), bindingGroup)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	consumer.Sink = adapter
	drainFrom(ctx, t, adapter, consumer, 1, 3)
	if applications != 1 {
		t.Fatal("crash replay duplicated effect")
	}
	req := kmsg.NewPtrOffsetFetchRequest()
	req.Group = bindingGroup
	req.Topics = []kmsg.OffsetFetchRequestTopic{{Topic: bindingTopic, Partitions: []int32{0}}}
	result, err := req.RequestWith(ctx, writer)
	if err != nil || result.Topics[0].Partitions[0].Offset != 3 {
		t.Fatal(result, err)
	}
	reader := bindingTestClient(t, cluster, kgo.ConsumeTopics(quarantineTopic), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	fetched := reader.PollRecords(ctx, 1)
	if fetched.Err() != nil || len(fetched.Records()) != 1 {
		t.Fatal(fetched.Err())
	}
	stopped, stop := context.WithCancel(ctx)
	stop()
	if _, err := adapter.Next(stopped); err == nil {
		t.Fatal("cancelled fetch succeeded")
	}
}

func TestBindingKafkaRetryExhaustionPreservesBrokerOffset(t *testing.T) {
	cluster := bindingCluster(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	writer := bindingTestClient(t, cluster, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	consumer, m := consumerFixture(t)
	if err := writer.ProduceSync(ctx, &kgo.Record{Topic: bindingTopic, Key: m.Key, Value: m.Value}).FirstErr(); err != nil {
		t.Fatal(err)
	}
	old := makeBindingClient
	makeBindingClient = func(opts ...kgo.Opt) (bindingKafkaClient, error) {
		return old(append(opts, kgo.Dialer(cluster.network.DialContext))...)
	}
	defer func() { makeBindingClient = old }()
	adapter, err := newBindingKafka(cluster.ListenAddrs(), bindingGroup)
	if err != nil {
		t.Fatal(err)
	}
	consumer.Source, consumer.Sink = adapter, adapter
	calls := 0
	failure := &pgconn.PgError{Code: "40001"}
	consumer.Apply = func(context.Context, []byte) (BindingOutcome, error) { calls++; return "", failure }
	if err := consumer.Run(ctx); !errors.Is(err, failure) || calls != 3 {
		t.Fatal(calls, err)
	}
	req := kmsg.NewPtrOffsetFetchRequest()
	req.Group = bindingGroup
	req.Topics = []kmsg.OffsetFetchRequestTopic{{Topic: bindingTopic, Partitions: []int32{0}}}
	offsets, err := req.RequestWith(ctx, writer)
	if err != nil || offsets.Topics[0].Partitions[0].Offset != -1 {
		t.Fatal(offsets, err)
	}
	adapter.Close()
	adapter, err = newBindingKafka(cluster.ListenAddrs(), bindingGroup)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	consumer.Source, consumer.Sink = adapter, adapter
	consumer.Apply = func(context.Context, []byte) (BindingOutcome, error) { calls++; return BindingApplied, nil }
	// Exactly one record, no following traffic: progress cannot depend on a batch flush.
	next, err := adapter.Next(ctx)
	if err != nil || next.Offset != 0 {
		t.Fatal(next, err)
	}
	if err := consumer.process(ctx, next); err != nil {
		t.Fatal(err)
	}
	offsets, err = req.RequestWith(ctx, writer)
	if err != nil || offsets.Topics[0].Partitions[0].Offset != 1 || calls != 4 {
		t.Fatal(offsets, calls, err)
	}
}

func (f *fakeBindingKafka) CommittedOffsets() map[string]map[int32]kgo.EpochOffset { return nil }
