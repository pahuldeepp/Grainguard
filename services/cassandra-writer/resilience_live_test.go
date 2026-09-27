package main

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"greenguard.local/cassandra-writer/history"
)

// liveOutage owns ONLY the local Cassandra container for the test's duration.
type liveOutage struct {
	t         *testing.T
	container string
	admin     *kgo.Client
	group     string
	stopped   bool
}

func (o *liveOutage) docker(action string) {
	o.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "docker", action, o.container).CombinedOutput(); err != nil {
		o.t.Fatalf("docker %s %s: %v: %s", action, o.container, err, out)
	}
	o.stopped = action != "start"
}

type producedReading struct {
	tenant, device string
	reading        recoveryReading
	offset         int64
}

func (o *liveOutage) produce(ctx context.Context, n int) []producedReading {
	o.t.Helper()
	out := make([]producedReading, 0, n)
	for i := 0; i < n; i++ {
		event, tenant, device, reading := recoveryEvent(o.t)
		record := &kgo.Record{Topic: topicTelemetry, Partition: 0, Key: []byte(tenant + ":" + device), Value: event,
			Headers: []kgo.RecordHeader{{Key: fieldTenant, Value: []byte(tenant)}, {Key: fieldEvent, Value: []byte(reading.event)}, {Key: fieldType, Value: []byte(typeTelemetry)}, {Key: fieldSchema, Value: []byte("1")}}}
		if err := o.admin.ProduceSync(ctx, record).FirstErr(); err != nil {
			o.t.Fatal(err)
		}
		out = append(out, producedReading{tenant, device, reading, record.Offset})
	}
	return out
}

// holdOutage keeps Cassandra down for d while the worker keeps running and
// must not advance the committed offset past the first outage record.
func (o *liveOutage) holdOutage(ctx context.Context, p *Processor, done <-chan error, first int64, d time.Duration) {
	o.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			o.t.Fatalf("writer exited during Cassandra outage: %v", err)
		case <-time.After(5 * time.Second):
		}
		if got := committedOffset(o.t, ctx, o.admin, o.group, 0); got > first {
			o.t.Fatalf("offset advanced to %d during outage (first outage record %d)", got, first)
		}
	}
	if !p.Degraded.Load() || p.Ready.Load() {
		o.t.Fatalf("outage not reported: degraded=%v ready=%v", p.Degraded.Load(), p.Ready.Load())
	}
	o.t.Logf("held %s outage: degraded=1 outage_seconds=%.0f retries=%d", d, p.outageSeconds(), p.Retries.Load())
}

func (o *liveOutage) recover(ctx context.Context, p *Processor, done <-chan error, want int64) {
	o.t.Helper()
	o.docker("start")
	for committedOffset(o.t, ctx, o.admin, o.group, 0) < want {
		select {
		case err := <-done:
			o.t.Fatalf("writer exited during recovery: %v", err)
		case <-ctx.Done():
			o.t.Fatalf("no catch-up to offset %d: %v", want, ctx.Err())
		case <-time.After(2 * time.Second):
		}
	}
	if p.Degraded.Load() {
		o.t.Fatal("still degraded after catch-up")
	}
}

func assertExactlyOnce(t *testing.T, ctx context.Context, store *history.Store, rows []producedReading) {
	t.Helper()
	for _, r := range rows {
		result, err := store.Query(ctx, r.tenant, r.device, r.reading.observed.Add(-time.Second), r.reading.observed.Add(time.Second))
		if err != nil || len(result.Readings) != 1 || result.Readings[0].ReadingID != r.reading.id {
			t.Fatalf("offset %d: want exactly one row %s, got %+v err=%v", r.offset, r.reading.id, result.Readings, err)
		}
	}
}

func outageDuration() time.Duration {
	if s, err := strconv.Atoi(os.Getenv("CASSANDRA_OUTAGE_SECONDS")); err == nil && s > 0 {
		return time.Duration(s) * time.Second
	}
	return 130 * time.Second
}

// TestLiveWriterSurvivesCassandraOutages runs the production worker path
// (lazy reconnecting session, Run loop) through a startup while Cassandra is
// stopped and then a long outage of a connected worker.
func TestLiveWriterSurvivesCassandraOutages(t *testing.T) {
	if os.Getenv("KAFKA_CASSANDRA_RESILIENCE_LIVE") != "1" {
		t.Skip("set KAFKA_CASSANDRA_RESILIENCE_LIVE=1 to stop and start the local Cassandra container")
	}
	container := os.Getenv("CASSANDRA_TEST_CONTAINER")
	if container == "" {
		container = "greenguard-dev-cassandra-1"
	}
	long := outageDuration()
	ctx, cancel := context.WithTimeout(context.Background(), long+6*time.Minute)
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
	o := &liveOutage{t: t, container: container, admin: admin, group: "cassandra-resilience-" + uuid()}
	t.Cleanup(func() {
		if o.stopped {
			o.docker("start")
		}
	})
	commitBaseline(t, ctx, admin, o.group, topicEnds(t, ctx, admin, topicTelemetry))
	cfg, err := history.LoadConfig(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := loadSchema("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	o.docker("stop")
	session := &history.Reconnecting{Open: func() (history.Conn, error) { return history.Open(cfg) }}
	defer session.Close()
	consumer, err := newKafka(brokers, o.group)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	store := &history.Store{Session: session, TTL: 24 * time.Hour, MaxRows: 10, MaxDays: 2}
	p := &Processor{Source: consumer, Sink: consumer, Schema: schema, Store: store, Transient: history.Transient, Rejected: history.Rejected,
		Attempts: 3, RetryDelay: 200 * time.Millisecond, MaxBackoff: 5 * time.Second, ProcessTimeout: 10 * time.Second, Connect: session.Connect}
	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- p.Run(runCtx) }()

	startup := o.produce(ctx, 3)
	o.holdOutage(ctx, p, done, startup[0].offset, 30*time.Second)
	o.recover(ctx, p, done, startup[len(startup)-1].offset+1)
	assertExactlyOnce(t, ctx, store, startup)
	t.Logf("startup-while-down passed: offsets %d..%d", startup[0].offset, startup[len(startup)-1].offset)

	o.docker("stop")
	during := o.produce(ctx, 5)
	o.holdOutage(ctx, p, done, during[0].offset, long)
	o.recover(ctx, p, done, during[len(during)-1].offset+1)
	assertExactlyOnce(t, ctx, store, during)
	t.Logf("long outage passed: %s, offsets %d..%d, outages=%d sessions_opened=%d", long, during[0].offset, during[len(during)-1].offset, p.Outages.Load(), session.Reconnects.Load())
	stop()
	if err := <-done; err != nil && runCtx.Err() == nil {
		t.Fatalf("writer stopped with %v", err)
	}
}
