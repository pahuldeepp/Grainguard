package main

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"greenguard.local/cassandra-writer/history"
)

var errDown = errors.New("cassandra down")

func noJitter(int64) int64 { return 0 }

func TestBackoffDelayIsBoundedAndJittered(t *testing.T) {
	for _, tc := range []struct {
		base, maxDelay time.Duration
		attempt        int
		want           time.Duration
	}{
		{time.Second, 30 * time.Second, 0, 500 * time.Millisecond},
		{time.Second, 30 * time.Second, 3, 4 * time.Second},
		{time.Second, 30 * time.Second, 50, 15 * time.Second},
		{0, 0, 0, 500 * time.Microsecond},
		{time.Second, time.Millisecond, 4, 500 * time.Millisecond},
	} {
		if got := backoffDelay(tc.base, tc.maxDelay, tc.attempt, noJitter); got != tc.want {
			t.Fatalf("backoff(%v,%v,%d) = %v, want %v", tc.base, tc.maxDelay, tc.attempt, got, tc.want)
		}
	}
	full := func(n int64) int64 { return n - 1 }
	if got := backoffDelay(time.Second, 30*time.Second, 50, full); got != 30*time.Second {
		t.Fatalf("max jitter = %v", got)
	}
	for i := 0; i < 100; i++ {
		if d := backoffDelay(time.Second, 8*time.Second, 10, jitterN); d < 4*time.Second || d > 8*time.Second {
			t.Fatalf("jittered delay out of bounds: %v", d)
		}
	}
}

func TestSleepCtxHonoursCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := sleepCtx(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := sleepCtx(context.Background(), time.Microsecond); err != nil {
		t.Fatal(err)
	}
}

func resilientProcessor() *Processor {
	return &Processor{Transient: func(err error) bool { return errors.Is(err, errDown) }, RetryDelay: time.Microsecond, MaxBackoff: time.Millisecond, Jitter: noJitter}
}

func TestUntilWaitsOutOutageThenRecovers(t *testing.T) {
	p := resilientProcessor()
	p.Ready.Store(true)
	calls := 0
	var sawDegraded bool
	err := p.until(context.Background(), func(context.Context) error {
		calls++
		if calls > 1 {
			sawDegraded = p.Degraded.Load() && !p.Ready.Load() && p.outageSeconds() >= 0 && p.OutageStarted.Load() != 0
		}
		if calls < 20 {
			return errDown
		}
		return nil
	})
	if err != nil || calls != 20 || !sawDegraded {
		t.Fatalf("err=%v calls=%d degraded=%v", err, calls, sawDegraded)
	}
	if p.Degraded.Load() || p.outageSeconds() != 0 || p.Outages.Load() != 1 {
		t.Fatalf("not recovered: degraded=%v outage=%v outages=%d", p.Degraded.Load(), p.outageSeconds(), p.Outages.Load())
	}
}

func TestUntilTreatsWorkDeadlineAsOutage(t *testing.T) {
	p := resilientProcessor()
	calls := 0
	err := p.until(context.Background(), func(context.Context) error {
		calls++
		if calls == 1 {
			return context.DeadlineExceeded
		}
		return nil
	})
	if err != nil || calls != 2 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}

func TestUntilStopsOnFatalErrorAndShutdown(t *testing.T) {
	p := resilientProcessor()
	fatal := errors.New("schema drift")
	if err := p.until(context.Background(), func(context.Context) error { return fatal }); !errors.Is(err, fatal) {
		t.Fatalf("fatal = %v", err)
	}
	p.Transient = nil
	if err := p.until(context.Background(), func(context.Context) error { return errDown }); !errors.Is(err, errDown) {
		t.Fatalf("nil classifier = %v", err)
	}
	p = resilientProcessor()
	ctx, cancel := context.WithCancel(context.Background())
	if err := p.until(ctx, func(context.Context) error { cancel(); return errDown }); !errors.Is(err, context.Canceled) {
		t.Fatalf("shutdown = %v", err)
	}
	p.MaxBackoff = time.Hour
	ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	p.RetryDelay = time.Hour
	if err := p.until(ctx, func(context.Context) error { return errDown }); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown during backoff = %v", err)
	}
}

func TestProcessorDefaults(t *testing.T) {
	p := &Processor{}
	if p.maxBackoff() != defaultMaxBackoff || p.jitter()(1) != 0 {
		t.Fatal("defaults")
	}
}

type fakeSource struct {
	msgs []Message
	i    int
}

var errSourceDone = errors.New("source drained")

func (s *fakeSource) Next(context.Context) (Message, error) {
	if s.i >= len(s.msgs) {
		return Message{}, errSourceDone
	}
	s.i++
	return s.msgs[s.i-1], nil
}

func TestRunStartsWhileDownAndHoldsOffsetThroughOutage(t *testing.T) {
	raw := validTelemetry(t)
	schema, err := loadSchema("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	commits := 0
	msg := telemetryMessage(raw, func(context.Context) error { commits++; return nil })
	msg.EndOffset = 1
	connects, writes := 0, 0
	store := &flakyWriter{fail: 5, err: errDown, writes: &writes}
	p := resilientProcessor()
	p.Schema, p.Store, p.Rejected, p.Attempts, p.ProcessTimeout = schema, store, history.Rejected, 1, time.Second
	p.Source = &fakeSource{msgs: []Message{msg}}
	p.Connect = func() error {
		connects++
		if connects < 3 {
			return errDown
		}
		return nil
	}
	if err := p.Run(context.Background()); !errors.Is(err, errSourceDone) {
		t.Fatalf("run = %v", err)
	}
	if connects != 3 || writes != 6 || commits != 1 || p.Written.Load() != 1 || p.Outages.Load() != 2 {
		t.Fatalf("connects=%d writes=%d commits=%d written=%d outages=%d", connects, writes, commits, p.Written.Load(), p.Outages.Load())
	}
}

func TestRunStopsWhenStartupIsCancelled(t *testing.T) {
	p := resilientProcessor()
	ctx, cancel := context.WithCancel(context.Background())
	p.Connect = func() error { cancel(); return errDown }
	if err := p.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestRunFatalWriteErrorStopsWithoutCommit(t *testing.T) {
	raw := validTelemetry(t)
	schema, _ := loadSchema("../../contracts/events")
	commits, writes := 0, 0
	fatal := errors.New("invalid query")
	p := resilientProcessor()
	p.Schema, p.Store, p.Rejected, p.Attempts, p.ProcessTimeout = schema, &flakyWriter{fail: 1, err: fatal, writes: &writes}, history.Rejected, 1, time.Second
	p.Source = &fakeSource{msgs: []Message{telemetryMessage(raw, func(context.Context) error { commits++; return nil })}}
	if err := p.Run(context.Background()); !errors.Is(err, fatal) || commits != 0 {
		t.Fatalf("err=%v commits=%d", err, commits)
	}
}

func TestMetricsReportDegradedWithoutTenantLabels(t *testing.T) {
	p := resilientProcessor()
	p.degrade(errDown, 0, 0)
	a := &app{processor: p, session: &history.Reconnecting{}}
	rec := httptest.NewRecorder()
	a.metrics(rec, httptest.NewRequest("GET", "/metrics", nil))
	body := rec.Body.String()
	for _, want := range []string{"history_cassandra_degraded 1", "history_cassandra_outages_total 1", "history_cassandra_sessions_opened_total 0", "history_cassandra_outage_seconds "} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "tenant") || strings.Contains(body, "{") {
		t.Fatalf("metrics carry labels:\n%s", body)
	}
	p.restore()
	a.session = nil
	rec = httptest.NewRecorder()
	a.metrics(rec, httptest.NewRequest("GET", "/metrics", nil))
	if !strings.Contains(rec.Body.String(), "history_cassandra_degraded 0") {
		t.Fatal(rec.Body.String())
	}
}

type flakyWriter struct {
	fail   int
	err    error
	writes *int
}

func (w *flakyWriter) Write(context.Context, history.Reading) error {
	*w.writes++
	if *w.writes <= w.fail {
		return w.err
	}
	return nil
}

func (*flakyWriter) Confirm(context.Context, history.Watermark) error { return nil }

func validTelemetry(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("../../tests/fixtures/events/telemetry-recorded.v1.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func telemetryMessage(raw []byte, commit func(context.Context) error) Message {
	tenant := "11111111-1111-4111-8111-111111111111"
	return Message{Topic: topicTelemetry, Key: []byte(tenant + ":33333333-3333-4333-8333-333333333333"), Value: raw, Commit: commit,
		Headers: []kgo.RecordHeader{{Key: fieldEvent, Value: []byte("0d72ff07-a646-4d41-9b5b-52c5f25e4ca8")}, {Key: fieldType, Value: []byte(typeTelemetry)}, {Key: fieldSchema, Value: []byte("1")}, {Key: fieldTenant, Value: []byte(tenant)}}}
}
