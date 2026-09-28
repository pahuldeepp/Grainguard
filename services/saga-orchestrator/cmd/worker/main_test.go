package main

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"greenguard.local/saga-orchestrator/saga"
)

func TestLoadConfigFailsClosedAndRejectsStaticTenantList(t *testing.T) {
	base := map[string]string{"SAGA_DATABASE_URL": "postgres://x", "KAFKA_BROKERS": "a:1, b:2"}
	get := func(extra map[string]string) func(string) string {
		return func(k string) string {
			if v, ok := extra[k]; ok {
				return v
			}
			return base[k]
		}
	}
	cfg, err := loadConfig(get(nil))
	if err != nil || len(cfg.brokers) != 2 || cfg.maxShards != saga.ShardCount || cfg.holder == "" ||
		cfg.group != "greenguard-saga-orchestrator-v1" || cfg.ttl.Seconds() != 15 {
		t.Fatalf("defaults: %+v %v", cfg, err)
	}
	if _, err := loadConfig(get(map[string]string{"SHARD_ROUTING_REQUIRED": "true"})); err == nil {
		t.Fatal("required shard routing accepted missing registry with legacy URL present")
	}
	if _, err := loadConfig(get(map[string]string{"SHARD_ROUTING_REQUIRED": "false"})); err != nil {
		t.Fatalf("explicit legacy local mode rejected: %v", err)
	}
	cfg, err = loadConfig(get(map[string]string{"SAGA_LEASE_TTL_SECONDS": "4", "SAGA_MAX_SHARDS": "8", "SAGA_WORKER_ID": "w1", "SAGA_RESULT_GROUP": "g"}))
	if err != nil || cfg.ttl.Seconds() != 4 || cfg.maxShards != 8 || cfg.holder != "w1" || cfg.group != "g" {
		t.Fatalf("overrides: %+v %v", cfg, err)
	}
	for _, bad := range []map[string]string{
		{"SAGA_TENANT_IDS": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},
		{"SAGA_DATABASE_URL": ""}, {"KAFKA_BROKERS": ""},
		{"SAGA_LEASE_TTL_SECONDS": "1"}, {"SAGA_LEASE_TTL_SECONDS": "x"},
		{"SAGA_MAX_SHARDS": "0"}, {"SAGA_MAX_SHARDS": "65"},
	} {
		if _, err := loadConfig(get(bad)); err == nil {
			t.Fatalf("invalid config accepted: %v", bad)
		}
	}
}

func TestVisitStopsShardOnLostLease(t *testing.T) {
	calls := 0
	lost, err := visit([]string{"a", "b"}, func(string) error { calls++; return saga.ErrLeaseLost })
	if !lost || err != nil || calls != 1 {
		t.Fatalf("lost lease: %v %v %d", lost, err, calls)
	}
	boom := errors.New("db down")
	if _, err := visit([]string{"a"}, func(string) error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("db error: %v", err)
	}
	if lost, err := visit([]string{"a", "b"}, func(string) error { return nil }); lost || err != nil {
		t.Fatalf("clean visit: %v %v", lost, err)
	}
}

func TestRunRejectsInvalidConfigBeforeConnecting(t *testing.T) {
	if err := run(context.Background(), func(string) string { return "" }); err == nil {
		t.Fatal("empty config accepted")
	}
}

type poisonKafka struct {
	committed, published bool
	publishErr           error
	cancel               context.CancelFunc
}

func (f *poisonKafka) PollRecords(context.Context, int) kgo.Fetches {
	record := &kgo.Record{Topic: saga.ResultTopic, Key: []byte("bad"), Value: []byte("{"), Offset: 1}
	partition := kgo.FetchPartition{Records: []*kgo.Record{record}}
	topic := kgo.FetchTopic{Topic: saga.ResultTopic, Partitions: []kgo.FetchPartition{partition}}
	return kgo.Fetches{{Topics: []kgo.FetchTopic{topic}}}
}
func (f *poisonKafka) CommitRecords(context.Context, ...*kgo.Record) error {
	f.committed = true
	if f.cancel != nil {
		f.cancel()
	}
	return nil
}
func (f *poisonKafka) CommittedOffsets() map[string]map[int32]kgo.EpochOffset { return nil }
func (f *poisonKafka) ProduceSync(context.Context, ...*kgo.Record) kgo.ProduceResults {
	f.published = true
	return kgo.ProduceResults{{Err: f.publishErr}}
}
func (f *poisonKafka) AllowRebalance()            {}
func (f *poisonKafka) Ping(context.Context) error { return nil }
func (f *poisonKafka) CloseAllowingRebalance()    {}

func TestPoisonResultCommitsOnlyAfterDLQ(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := &poisonKafka{cancel: cancel}
	err := consumeResults(ctx, saga.Store{}, fake, fake)
	if err != nil || !fake.published || !fake.committed {
		t.Fatalf("poison record must publish DLQ before offset commit: err=%v published=%v committed=%v", err, fake.published, fake.committed)
	}
}

func TestPoisonResultHoldsOffsetWhenDLQFails(t *testing.T) {
	fake := &poisonKafka{publishErr: errors.New("broker down")}
	err := consumeResults(context.Background(), saga.Store{}, fake, fake)
	if !errors.Is(err, fake.publishErr) || fake.committed {
		t.Fatalf("failed DLQ must hold offset: err=%v committed=%v", err, fake.committed)
	}
}

func TestCommandHeadersCarryTraceContext(t *testing.T) {
	if h := commandHeaders([]byte(`{"tenant_id":"t","correlation_id":"s","traceparent":"00-a-b-01"}`)); h["traceparent"] != "00-a-b-01" || h["correlation_id"] != "s" || h["tenant_id"] != "t" {
		t.Fatalf("headers=%v", h)
	}
	if h := commandHeaders([]byte(`not json`)); h != nil {
		t.Fatalf("bad command headers=%v", h)
	}
}

func TestLoadConfigReadsMetricsAddress(t *testing.T) {
	env := map[string]string{"SAGA_DATABASE_URL": "postgres://x", "KAFKA_BROKERS": "b", "SAGA_METRICS_ADDR": " 127.0.0.1:0 "}
	cfg, err := loadConfig(func(k string) string { return env[k] })
	if err != nil || cfg.metrics != "127.0.0.1:0" {
		t.Fatalf("cfg=%+v err=%v", cfg, err)
	}
}

func TestServeMetricsReportsListenerFailureAndStops(t *testing.T) {
	errs := make(chan error, 1)
	stop := serveMetrics(context.Background(), "256.0.0.1:1", http.NotFoundHandler(), errs)
	defer stop()
	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("nil listener error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("listener failure not reported")
	}
	ok := serveMetrics(context.Background(), "127.0.0.1:0", http.NotFoundHandler(), errs)
	ok()
}
