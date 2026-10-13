package hardware

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
)

type fakeKafka struct {
	published    []*kgo.Record
	publishError error
}

func (f *fakeKafka) PollRecords(context.Context, int) kgo.Fetches           { return kgo.Fetches{} }
func (f *fakeKafka) CommitRecords(context.Context, ...*kgo.Record) error    { return nil }
func (f *fakeKafka) CommittedOffsets() map[string]map[int32]kgo.EpochOffset { return nil }
func (f *fakeKafka) ProduceSync(_ context.Context, records ...*kgo.Record) kgo.ProduceResults {
	f.published = append(f.published, records...)
	return kgo.ProduceResults{{Record: records[0], Err: f.publishError}}
}
func (f *fakeKafka) AllowRebalance()            {}
func (f *fakeKafka) Ping(context.Context) error { return nil }
func (f *fakeKafka) CloseAllowingRebalance()    {}

func TestLiveWorkerCrashBeforePublishReplaysStableResult(t *testing.T) {
	p := pool(t)
	tenant, asset, device, saga := uuid(t), uuid(t), uuid(t), uuid(t)
	register(t, p, tenant, asset)
	c := newCommand(t, tenant, asset, device, saga, "asset.reserve")
	value, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	commits := 0
	m := transport.Message{Key: []byte(tenant + ":" + saga), Value: value, Commit: func(context.Context) error { commits++; return nil }}
	broker := &fakeKafka{publishError: errors.New("broker offline")}
	w := Worker{Store: Store{DB: p}, Client: broker}
	if err := w.process(context.Background(), m); err == nil || commits != 0 {
		t.Fatalf("offline broker should not commit: %v commits=%d", err, commits)
	}
	broker.publishError = nil
	if err := w.process(context.Background(), m); err != nil || commits != 1 {
		t.Fatalf("redelivery: %v commits=%d", err, commits)
	}
	if len(broker.published) != 2 {
		t.Fatalf("published %d results", len(broker.published))
	}
	var first, second Result
	if err := json.Unmarshal(broker.published[0].Value, &first); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(broker.published[1].Value, &second); err != nil {
		t.Fatal(err)
	}
	if first.ResultID == "" || first.ResultID != second.ResultID || second.Outcome != "succeeded" {
		t.Fatalf("unstable replay results: %+v %+v", first, second)
	}
}

func TestWorkerRejectsMalformedCommandsWithoutCommit(t *testing.T) {
	broker := &fakeKafka{}
	w := Worker{Client: broker}
	commits := 0
	m := transport.Message{Value: []byte("{"), Commit: func(context.Context) error { commits++; return nil }}
	if err := w.process(context.Background(), m); err == nil || commits != 0 {
		t.Fatalf("malformed command committed: %v %d", err, commits)
	}
	data, _ := json.Marshal(Command{Step: "asset.reserve"})
	m.Value = data
	if err := w.process(context.Background(), m); err == nil || commits != 0 {
		t.Fatalf("invalid command committed: %v %d", err, commits)
	}
	data, _ = json.Marshal(Command{Step: "inventory.activate"})
	m.Value = data
	if err := w.process(context.Background(), m); err != nil || commits != 1 {
		t.Fatalf("other owner command not skipped: %v %d", err, commits)
	}
}

func TestWorkerRunStopsOnErrorAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	w := Worker{Next: func(context.Context) (transport.Message, error) {
		return transport.Message{}, errors.New("source failed")
	}}
	if err := w.Run(ctx); err == nil {
		t.Fatal("source error ignored")
	}
	cancel()
	if err := w.Run(ctx); err != nil {
		t.Fatalf("cancellation not graceful: %v", err)
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	w.Next = func(context.Context) (transport.Message, error) {
		cancel2()
		return transport.Message{}, context.Canceled
	}
	if err := w.Run(ctx2); err != nil {
		t.Fatalf("poll cancellation not graceful: %v", err)
	}
	ctx3, cancel3 := context.WithCancel(context.Background())
	commits := 0
	seen := false
	w.Next = func(context.Context) (transport.Message, error) {
		if seen {
			cancel3()
			return transport.Message{}, context.Canceled
		}
		seen = true
		return transport.Message{Value: []byte(`{"step":"inventory.activate"}`), Commit: func(context.Context) error { commits++; return nil }}, nil
	}
	if err := w.Run(ctx3); err != nil || commits != 1 {
		t.Fatalf("successful skip/stop: %v commits=%d", err, commits)
	}
}

func TestKafkaClientRequiresBroker(t *testing.T) {
	if _, err := KafkaClient(nil); err == nil {
		t.Fatal("empty broker accepted")
	}
	c, err := KafkaClient([]string{"localhost:9092"})
	if err != nil {
		t.Fatal(err)
	}
	c.CloseAllowingRebalance()
}

func TestResultHeadersCarrySagaTraceContext(t *testing.T) {
	const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
	h := resultHeaders(Result{TenantID: "t", SagaID: "11111111-1111-4111-8111-111111111111",
		CommandID: "22222222-2222-4222-8222-222222222222", Traceparent: tp})
	if h["traceparent"] != tp || h["correlation_id"] != "11111111-1111-4111-8111-111111111111" || h["tenant_id"] != "t" {
		t.Fatalf("headers=%v", h)
	}
	if _, ok := resultHeaders(Result{TenantID: "t", SagaID: "s", CommandID: "c"})["traceparent"]; ok {
		t.Fatal("a result without a stored trace must not invent one")
	}
}

func TestCommandTraceIsSanitizedAndExcludedFromRequestHash(t *testing.T) {
	cases := map[string]string{
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-02": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
		"00-00000000000000000000000000000000-00f067aa0ba902b7-01": "",
		"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01": "",
		"01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01": "",
		"": "",
	}
	for in, want := range cases {
		if got := commandTrace(Command{Traceparent: in}); got != want {
			t.Errorf("commandTrace(%q)=%q want %q", in, got, want)
		}
	}
	a, b := Command{Step: "asset.reserve", Traceparent: "x"}, Command{Step: "asset.reserve"}
	if requestHash(a) != requestHash(b) {
		t.Fatal("trace context must not change the command identity hash")
	}
}

func TestKafkaClientAllowsAnIsolatedConsumerGroup(t *testing.T) {
	if _, err := KafkaClientForGroupWithReadiness([]string{"127.0.0.1:59092"}, " ", nil); err == nil {
		t.Fatal("blank consumer group accepted")
	}
	client, err := KafkaClientForGroupWithReadiness([]string{"127.0.0.1:59092"}, "local-provisioning-test", nil)
	if err != nil {
		t.Fatal(err)
	}
	client.Close()
}
