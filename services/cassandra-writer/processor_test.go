package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"greenguard.local/cassandra-writer/history"
)

type testWriter struct {
	steps                *[]string
	writeErr, confirmErr error
}

func (w testWriter) Write(context.Context, history.Reading) error {
	*w.steps = append(*w.steps, "write")
	return w.writeErr
}

func (w testWriter) Confirm(context.Context, history.Watermark) error {
	*w.steps = append(*w.steps, "confirm")
	return w.confirmErr
}

type testSink struct {
	steps *[]string
	err   error
}

func (s testSink) Publish(context.Context, Record) error {
	*s.steps = append(*s.steps, "quarantine")
	return s.err
}

func TestProcessorCommitsOnlyAfterHistoryAndWatermark(t *testing.T) {
	raw, err := os.ReadFile("../../tests/fixtures/events/telemetry-recorded.v1.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	schema, err := loadSchema("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name                 string
		writeErr, confirmErr error
		want                 string
	}{
		{name: "success", want: "write,confirm,commit"},
		{name: "write fails", writeErr: errors.New("write unavailable"), want: "write"},
		{name: "watermark fails", confirmErr: errors.New("watermark unavailable"), want: "write,confirm"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			steps := []string{}
			p := &Processor{Schema: schema, Store: testWriter{&steps, tc.writeErr, tc.confirmErr}, Sink: testSink{steps: &steps}, Transient: func(error) bool { return false }, Rejected: func(error) bool { return false }, Attempts: 1, RetryDelay: time.Millisecond}
			m := Message{Topic: topicTelemetry, Key: []byte("11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333"), Value: raw, Headers: []kgo.RecordHeader{{Key: fieldEvent, Value: []byte("0d72ff07-a646-4d41-9b5b-52c5f25e4ca8")}, {Key: fieldType, Value: []byte(typeTelemetry)}, {Key: fieldSchema, Value: []byte("1")}, {Key: fieldTenant, Value: []byte("11111111-1111-4111-8111-111111111111")}}, Commit: func(context.Context) error { steps = append(steps, "commit"); return nil }}
			err := p.process(context.Background(), m)
			if (err != nil) != (tc.writeErr != nil || tc.confirmErr != nil) {
				t.Fatalf("unexpected error: %v", err)
			}
			got := ""
			for i, step := range steps {
				if i > 0 {
					got += ","
				}
				got += step
			}
			if got != tc.want {
				t.Fatalf("steps = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestProcessorPoisonCommitWaitsForQuarantineAck(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		publishErr error
	}{
		{name: "quarantine acknowledged", want: "quarantine,commit"},
		{name: "quarantine failed", want: "quarantine", publishErr: errors.New("broker unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			steps := []string{}
			p := &Processor{Sink: testSink{steps: &steps, err: tc.publishErr}, Attempts: 1, RetryDelay: time.Millisecond, Rejected: func(error) bool { return false }}
			m := Message{Topic: topicTelemetry, Value: []byte("{"), Commit: func(context.Context) error { steps = append(steps, "commit"); return nil }}
			err := p.process(context.Background(), m)
			if (err != nil) != (tc.publishErr != nil) {
				t.Fatalf("unexpected error: %v", err)
			}
			got := strings.Join(steps, ",")
			if got != tc.want {
				t.Fatalf("steps = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestProcessorOversizedPoisonHoldsOffset(t *testing.T) {
	steps := []string{}
	p := &Processor{Sink: testSink{steps: &steps}, Attempts: 1, Rejected: func(error) bool { return false }}
	m := Message{Topic: topicTelemetry, Value: []byte(strings.Repeat("x", maxQuarantineRawBytes+1)), Commit: func(context.Context) error { steps = append(steps, "commit"); return nil }}
	if err := p.process(context.Background(), m); !errors.Is(err, errQuarantinePayloadTooLarge) {
		t.Fatalf("got %v, want oversized quarantine error", err)
	}
	if len(steps) != 0 {
		t.Fatalf("oversized record was published or committed: %v", steps)
	}
}
