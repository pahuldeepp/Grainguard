package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/twmb/franz-go/pkg/kgo"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

var errTest = errors.New("injected failure")

func validEvent(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile("../../tests/fixtures/events/telemetry-recorded.v1.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	v, err := decode(b)
	if err != nil {
		t.Fatal(err)
	}
	return v.(map[string]any)
}
func message(e map[string]any) Message {
	b, _ := json.Marshal(e)
	headers := []kgo.RecordHeader{}
	for _, k := range []string{fieldEvent, fieldType, fieldSchema, fieldTenant, fieldCorrelation, fieldTrace} {
		headers = append(headers, kgo.RecordHeader{Key: k, Value: []byte(fmt.Sprint(e[k]))})
	}
	return Message{Topic: route(e), Key: []byte(fmt.Sprint(e[fieldTenant]) + ":" + fmt.Sprint(e[fieldAggregate])), Value: b, Headers: headers, Commit: func(context.Context) error { return nil }}
}

type memorySink struct {
	records []Record
	err     error
}

func (s *memorySink) PublishQuarantine(_ context.Context, r Record) error {
	s.records = append(s.records, r)
	return s.err
}
func testProcessor(t *testing.T) *Processor {
	t.Helper()
	s, err := loadSchemas("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	return &Processor{Schemas: s, Sink: &memorySink{}, Attempts: 3, ProcessTimeout: time.Second, Apply: func(context.Context, Message, map[string]any) error { return nil }, Heartbeat: func(context.Context, Message) error { return nil }}
}
func TestQuarantineReasons(t *testing.T) {
	cases := []struct {
		name, reason string
		change       func(*Message, map[string]any)
		db           error
	}{
		{"bad json", reasonEnvelope, func(m *Message, e map[string]any) { m.Value = []byte("{") }, nil},
		{"not object", reasonEnvelope, func(m *Message, e map[string]any) { m.Value = []byte("null") }, nil},
		{"unknown", reasonUnknown, func(m *Message, e map[string]any) { e[fieldType] = "future"; *m = message(e) }, nil},
		{"schema version", reasonUnknown, func(m *Message, e map[string]any) { e[fieldSchema] = 3; *m = message(e) }, nil},
		{"schema", reasonSchema, func(m *Message, e map[string]any) { e["extra"] = true; *m = message(e) }, nil},
		{"bigint", reasonBigint, func(m *Message, e map[string]any) { e[fieldVersion] = "9223372036854775808"; *m = message(e) }, nil},
		{"identity", reasonSchema, func(m *Message, e map[string]any) { e[fieldAggregate] = testTenant; *m = message(e) }, nil},
		{"key", reasonKey, func(m *Message, e map[string]any) { m.Key = []byte("wrong") }, nil},
		{"topic", reasonKey, func(m *Message, e map[string]any) { m.Topic = topicInventory }, nil},
		{"header", reasonHeaders, func(m *Message, e map[string]any) { m.Headers = nil }, nil},
		{"duplicate header", reasonHeaders, func(m *Message, e map[string]any) { m.Headers = append(m.Headers, m.Headers[0]) }, nil},
		{"conflict", reasonConflict, nil, ErrConflict},
		{"class22", reasonDB, nil, &pgconn.PgError{Code: "22003"}},
		{"class23", reasonDB, nil, &pgconn.PgError{Code: "23505"}},
		{"checkpoint", reasonHeartbeat, func(m *Message, e map[string]any) { m.Key = []byte(bindingHeartbeatKey) }, ErrCheckpoint},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := testProcessor(t)
			e := validEvent(t)
			m := message(e)
			if tc.change != nil {
				tc.change(&m, e)
			}
			p.Apply = func(context.Context, Message, map[string]any) error { return tc.db }
			p.Heartbeat = func(context.Context, Message) error { return tc.db }
			commits := 0
			m.Commit = func(context.Context) error {
				commits++
				if len(p.Sink.(*memorySink).records) != 1 {
					t.Fatal("commit before quarantine")
				}
				return nil
			}
			if err := p.process(context.Background(), m); err != nil {
				t.Fatal(err)
			}
			sink := p.Sink.(*memorySink)
			var body map[string]any
			_ = json.Unmarshal(sink.records[0].Value, &body)
			if body["reason"] != tc.reason || commits != 1 {
				t.Fatalf("%v commits=%d", body, commits)
			}
		})
	}
}
func TestRetryExhaustionAndQuarantineFailureNeverCommit(t *testing.T) {
	for _, db := range []error{io.EOF, &pgconn.PgError{Code: "40001"}, errTest} {
		p := testProcessor(t)
		calls := 0
		p.Apply = func(context.Context, Message, map[string]any) error { calls++; return db }
		m := message(validEvent(t))
		m.Commit = func(context.Context) error { t.Fatal("committed failed work"); return nil }
		if p.process(context.Background(), m) == nil {
			t.Fatal("missing failure")
		}
		want := 3
		if db == errTest {
			want = 1
		}
		if calls != want {
			t.Fatal(calls)
		}
	}
	p := testProcessor(t)
	p.Sink = &memorySink{err: errTest}
	m := message(validEvent(t))
	m.Value = []byte("broken")
	m.Commit = func(context.Context) error { t.Fatal("committed poison without ack"); return nil }
	if p.process(context.Background(), m) == nil {
		t.Fatal("missing publish failure")
	}
}
func TestCommitRetryDoesNotReapplyAndDuplicateRedelivery(t *testing.T) {
	p := testProcessor(t)
	applied := false
	effects := 0
	p.Apply = func(context.Context, Message, map[string]any) error {
		if applied {
			return ErrDuplicate
		}
		applied = true
		effects++
		return nil
	}
	m := message(validEvent(t))
	calls := 0
	m.Commit = func(context.Context) error { calls++; return errTest }
	if p.process(context.Background(), m) == nil || effects != 1 || calls != 3 {
		t.Fatal(effects, calls)
	}
	m.Commit = func(context.Context) error { return nil }
	if err := p.process(context.Background(), m); err != nil || effects != 1 || p.Duplicates.Load() != 1 {
		t.Fatal(err, effects)
	}
}
func TestRetryClassification(t *testing.T) {
	for _, code := range []string{"40001", "40P01", "55P03", "53300", "57P01", "57P02", "57P03", "08006"} {
		if !transientError(&pgconn.PgError{Code: code}) {
			t.Fatal(code)
		}
	}
	for _, e := range []error{errTest, &pgconn.PgError{Code: "23505"}, &pgconn.PgError{Code: "x"}} {
		if transientError(e) {
			t.Fatal(e)
		}
	}
	for _, e := range []error{context.Canceled, context.DeadlineExceeded} {
		if transportError(e) {
			t.Fatal(e)
		}
	}
}
func TestRetryCancellation(t *testing.T) {
	p := testProcessor(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if !errors.Is(p.retry(ctx, func(context.Context) error { return nil }, transportError), context.Canceled) {
		t.Fatal("cancel")
	}
	ctx, cancel = context.WithCancel(context.Background())
	p.RetryDelay = time.Hour
	if !errors.Is(p.retry(ctx, func(context.Context) error { cancel(); return errTest }, transportError), context.Canceled) {
		t.Fatal("wait cancel")
	}
}

type sequenceSource struct{ messages []Message }

func (s *sequenceSource) Next(ctx context.Context) (Message, error) {
	if len(s.messages) == 0 {
		return Message{}, io.EOF
	}
	m := s.messages[0]
	s.messages = s.messages[1:]
	return m, nil
}
func TestPoisonThenGoodRun(t *testing.T) {
	p := testProcessor(t)
	bad := message(validEvent(t))
	bad.Value = []byte("bad")
	good := message(validEvent(t))
	p.Source = &sequenceSource{[]Message{bad, good}}
	if !errors.Is(p.Run(context.Background()), io.EOF) || p.Applied.Load() != 1 || p.Quarantined.Load() != 1 || p.Ready.Load() {
		t.Fatal("flow")
	}
	p.Source = &sequenceSource{[]Message{good}}
	p.Apply = func(context.Context, Message, map[string]any) error { return errTest }
	if !errors.Is(p.Run(context.Background()), errTest) {
		t.Fatal("run failure")
	}
}
func TestQuarantineTenantAndTruncation(t *testing.T) {
	for _, id := range []string{testTenant, "bad", "", strings.Repeat("a", 70000)} {
		m := Message{Value: []byte(fmt.Sprintf(`{"tenant_id":%q}`, id))}
		r := quarantine(m, reasonSchema)
		want := "unknown"
		if id == testTenant {
			want = id
		}
		if r.Headers[fieldTenant] != want {
			t.Fatal(r.Headers)
		}
		var b map[string]any
		_ = json.Unmarshal(r.Value, &b)
		if b["truncated"] != (len(m.Value) > 65536) {
			t.Fatal(b["truncated"])
		}
	}
}
func TestHeartbeatFailures(t *testing.T) {
	for _, e := range []error{nil, ErrCheckpoint, &pgconn.PgError{Code: "23514"}, io.EOF} {
		p := testProcessor(t)
		p.Heartbeat = func(context.Context, Message) error { return e }
		m := Message{Key: []byte(bindingHeartbeatKey), Commit: func(context.Context) error { return nil }}
		err := p.process(context.Background(), m)
		if (err != nil) != (e == io.EOF) {
			t.Fatal(e, err)
		}
	}
}
