package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace/noop"
)

var errTest = errors.New("injected failure")

type sourceFunc func(context.Context) (Message, error)

func (f sourceFunc) Next(ctx context.Context) (Message, error) { return f(ctx) }

type sinkFunc func(context.Context, Record) error

func (f sinkFunc) Publish(ctx context.Context, r Record) error           { return f(ctx, r) }
func (f sinkFunc) PublishQuarantine(ctx context.Context, r Record) error { return f(ctx, r) }
func testProcessor(t *testing.T) *Processor {
	t.Helper()
	return &Processor{Schemas: testSchemas(t), Metrics: newMetrics(), Tracer: noop.NewTracerProvider().Tracer("test"), RetryDelay: time.Millisecond, ProcessTimeout: time.Second}
}

// frontierHarness scripts a source whose commits and a sink whose publishes
// both fail once, recording the order in which the processor acts.
type frontierHarness struct {
	t                        *testing.T
	p                        *Processor
	inputs                   [][]byte
	actions                  []string
	next, attempt, committed int
}

func (h *frontierHarness) Next(context.Context) (Message, error) {
	if h.next == len(h.inputs) {
		return Message{}, errTest
	}
	if h.next != h.committed {
		h.t.Fatal("fetched past uncommitted frontier")
	}
	index := h.next
	h.next++
	return Message{Topic: rawTelemetry, Offset: int64(index), Value: h.inputs[index],
		Commit: func(context.Context) error { return h.commit(index) }}, nil
}

func (h *frontierHarness) commit(index int) error {
	if index < 3 && h.attempt < 2 {
		h.t.Fatal("commit before acknowledged publish")
	}
	if index == 2 && h.attempt == 2 {
		h.attempt++
		h.actions = append(h.actions, "commit-fail")
		return errTest
	}
	h.committed++
	h.attempt = 0
	h.actions = append(h.actions, "commit")
	return nil
}

func (h *frontierHarness) publish(_ context.Context, r Record) error {
	h.attempt++
	if h.attempt == 1 {
		h.actions = append(h.actions, "publish-fail")
		return errTest
	}
	if h.p.Metrics.ready.Load() {
		h.t.Fatal("retry should be unready")
	}
	h.actions = append(h.actions, r.Topic)
	return nil
}

func TestCommitOrderingRetriesPoisonAndContiguousFrontier(t *testing.T) {
	p := testProcessor(t)
	raw := rawEvent(t, validEvent(t))
	h := &frontierHarness{t: t, p: p, inputs: [][]byte{raw, []byte("{"), raw, []byte(`{"op":"u"}`), nil}}
	p.Source = h
	p.Sink = sinkFunc(h.publish)
	if err := p.Run(context.Background()); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	want := []string{"publish-fail", topicTelemetry, "commit", "publish-fail", topicQuarantine, "commit", "publish-fail", topicTelemetry, "commit-fail", "commit", "commit", "commit"}
	if !reflect.DeepEqual(h.actions, want) {
		t.Fatalf("%v", h.actions)
	}
	if h.committed != 5 || p.Metrics.published.Load() != 2 || p.Metrics.quarantined[reasonEnvelope].Load() != 1 || p.Metrics.lag.Load() != 0 || p.Metrics.consumed.Load() != 5 {
		t.Fatal("wrong counters")
	}
}

func TestUnavailableSinkAndCancelNeverCommit(t *testing.T) {
	for _, raw := range [][]byte{rawEvent(t, validEvent(t)), []byte("{")} {
		p := testProcessor(t)
		ctx, cancel := context.WithCancel(context.Background())
		p.Source = sourceFunc(func(context.Context) (Message, error) {
			return Message{Topic: rawTelemetry, Value: raw, Commit: func(context.Context) error { t.Fatal("commit despite failed publish"); return nil }}, nil
		})
		p.Sink = sinkFunc(func(context.Context, Record) error { cancel(); return errTest })
		if err := p.Run(ctx); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		if p.Metrics.ready.Load() || p.Metrics.lag.Load() != 1 {
			t.Fatal("failure must be visible")
		}
	}
	p := testProcessor(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := p.retry(ctx, func(context.Context) error { t.Fatal("called after cancellation"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestDeadlineRetainsOffset(t *testing.T) {
	p := testProcessor(t)
	p.ProcessTimeout = 5 * time.Millisecond
	p.Source = sourceFunc(func(context.Context) (Message, error) {
		return Message{Topic: rawTelemetry, Value: []byte("{"), Commit: func(context.Context) error { t.Fatal("committed"); return nil }}, nil
	})
	p.Sink = sinkFunc(func(ctx context.Context, _ Record) error { <-ctx.Done(); return ctx.Err() })
	if err := p.Run(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

func TestTraceContinuesOriginWithoutRewriting(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	defer shutdownTracing(provider)
	p := testProcessor(t)
	p.Tracer = provider.Tracer("test")
	event := validEvent(t)
	record := canonicalRecord(event, topicTelemetry)
	origin := record.Headers[fieldTrace]
	for _, failure := range []bool{true, false} {
		err := p.publishAttempt(context.Background(), func(_ context.Context, got Record) error {
			if got.Headers[fieldTrace] != origin {
				t.Fatal("rewrote origin")
			}
			if failure {
				return errTest
			}
			return nil
		}, record)
		if (err != nil) != failure {
			t.Fatal(err)
		}
	}
	spans := recorder.Ended()
	if len(spans) != 2 {
		t.Fatal(spans)
	}
	for _, s := range spans {
		if s.Parent().TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" || s.Parent().SpanID().String() != "00f067aa0ba902b7" {
			t.Fatal("lost parent")
		}
	}
	if spans[0].SpanContext().SpanID() == spans[1].SpanContext().SpanID() {
		t.Fatal("retry reused span")
	}
}
