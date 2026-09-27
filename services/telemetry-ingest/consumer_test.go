package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type bindingSourceFunc func(context.Context) (BindingMessage, error)

func (f bindingSourceFunc) Next(ctx context.Context) (BindingMessage, error) { return f(ctx) }

type bindingSinkFunc func(context.Context, BindingRecord) error

func (f bindingSinkFunc) PublishQuarantine(ctx context.Context, r BindingRecord) error {
	return f(ctx, r)
}

func consumerFixture(t *testing.T) (*BindingConsumer, BindingMessage) {
	e := eventSpec{kind: eventRegistered, tenant: randomUUID(), device: randomUUID(), version: 1}.withIDs()
	m := BindingMessage{Topic: bindingTopic, Key: []byte(e.tenant + ":" + e.device), Value: canonicalBinding(e)}
	schemas, err := loadBindingSchemas("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	c := &BindingConsumer{Validate: schemas.Validate, Attempts: 3, RetryDelay: time.Microsecond, Timeout: time.Second}
	return c, m
}

func mutateForReason(m *BindingMessage, reason string) {
	switch reason {
	case reasonEnvelope:
		m.Value = []byte("{")
	case reasonType:
		m.Value = []byte(`{"event_type":"unknown"}`)
	case reasonSchema:
		m.Value = []byte(`{"event_type":"device.registered"}`)
	case reasonKey:
		m.Key = []byte("foreign:device")
	}
}

func expectQuarantine(t *testing.T, reason string, raw []byte, published *int) bindingSinkFunc {
	return func(_ context.Context, r BindingRecord) error {
		var q struct {
			Reason, Source string
			Raw            []byte `json:"raw_base64"`
		}
		if err := json.Unmarshal(r.Value, &q); err != nil {
			t.Fatal(err)
		}
		if r.Topic != quarantineTopic || q.Reason != reason || string(q.Raw) != string(raw) {
			t.Fatalf("bad quarantine: %s", r.Value)
		}
		*published++
		return nil
	}
}

func checkQuarantineReason(t *testing.T, reason string) {
	c, m := consumerFixture(t)
	mutateForReason(&m, reason)
	applied, published, committed := 0, 0, 0
	c.Apply = func(context.Context, []byte) (BindingOutcome, error) { applied++; return "", ErrEventConflict }
	c.Sink = expectQuarantine(t, reason, m.Value, &published)
	m.Commit = func(context.Context) error {
		if published != 1 {
			t.Fatal("offset before quarantine")
		}
		committed++
		return nil
	}
	if err := c.process(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if committed != 1 || c.Quarantined.Load() != 1 || (reason != reasonConflict && applied != 0) {
		t.Fatal("unsafe effect")
	}
}

func TestBindingConsumerEveryQuarantineReason(t *testing.T) {
	for _, reason := range []string{reasonEnvelope, reasonType, reasonSchema, reasonKey, reasonConflict} {
		t.Run(reason, func(t *testing.T) { checkQuarantineReason(t, reason) })
	}
	c, m := consumerFixture(t)
	m.Topic = "wrong"
	m.Value = []byte(strings.Repeat("x", bindingMaxRaw+1))
	if bindingReason(m) != reasonEnvelope {
		t.Fatal("foreign topic accepted")
	}
	var q struct {
		Raw       []byte `json:"raw_base64"`
		Truncated bool
	}
	_ = json.Unmarshal(bindingQuarantine(m, reasonEnvelope).Value, &q)
	if len(q.Raw) != bindingMaxRaw || !q.Truncated {
		t.Fatal("unbounded quarantine")
	}
	if !strings.Contains(c.metrics(), "binding_consumer_retries_total 0") {
		t.Fatal(c.metrics())
	}
}

func TestBindingConsumerRetryAndCommitFrontier(t *testing.T) {
	c, m := consumerFixture(t)
	applied, committed := 0, 0
	c.Apply = func(context.Context, []byte) (BindingOutcome, error) {
		applied++
		if applied == 1 {
			return "", &pgconn.PgError{Code: "40001"}
		}
		return BindingApplied, nil
	}
	m.Commit = func(context.Context) error {
		committed++
		if committed == 1 {
			return errBoom
		}
		return nil
	}
	if err := c.process(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if applied != 2 || committed != 2 || c.Retries.Load() != 2 {
		t.Fatal("commit retry reapplied effect")
	}
}

func TestBindingConsumerExhaustionAndPermanentFailuresNeverCommit(t *testing.T) {
	for _, failure := range []error{&pgconn.PgError{Code: "40P01"}, ErrVersionGap, ErrBindingMissing, errBoom} {
		c, m := consumerFixture(t)
		calls := 0
		c.Apply = func(context.Context, []byte) (BindingOutcome, error) { calls++; return "", failure }
		m.Commit = func(context.Context) error { t.Fatal("failed effect committed"); return nil }
		if err := c.process(context.Background(), m); !errors.Is(err, failure) {
			t.Fatal(err)
		}
		want := 1
		if transientBindingError(failure) {
			want = c.Attempts
		}
		if calls != want || c.Ready.Load() {
			t.Fatalf("attempts %d want %d", calls, want)
		}
	}
	c, m := consumerFixture(t)
	m.Value = []byte("{")
	c.Sink = bindingSinkFunc(func(context.Context, BindingRecord) error { return errBoom })
	if err := c.process(context.Background(), m); !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
}

func TestBindingConsumerPoisonThenGoodAndStopsAtFailure(t *testing.T) {
	c, good := consumerFixture(t)
	poison := good
	poison.Value = []byte("{")
	inputs := []BindingMessage{poison, good}
	next, committed := 0, 0
	c.Source = bindingSourceFunc(func(context.Context) (BindingMessage, error) {
		if next == len(inputs) {
			return BindingMessage{}, io.EOF
		}
		if next != committed {
			t.Fatal("fetched across uncommitted frontier")
		}
		m := inputs[next]
		next++
		m.Commit = func(context.Context) error { committed++; return nil }
		return m, nil
	})
	c.Sink = bindingSinkFunc(func(context.Context, BindingRecord) error { return nil })
	c.Apply = func(context.Context, []byte) (BindingOutcome, error) { return BindingDuplicate, nil }
	if err := c.Run(context.Background()); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	if committed != 2 || c.Ready.Load() {
		t.Fatal("wrong frontier/readiness")
	}
	c.Source = bindingSourceFunc(func(context.Context) (BindingMessage, error) { return good, nil })
	c.Apply = func(context.Context, []byte) (BindingOutcome, error) { return "", ErrVersionGap }
	if err := c.Run(context.Background()); !errors.Is(err, ErrVersionGap) {
		t.Fatal(err)
	}
}

func TestBindingConsumerRetryCancellationAndClassification(t *testing.T) {
	for _, code := range []string{"40001", "40P01", "55P03", "53300", "57P01", "57P02", "57P03", "08006"} {
		if !transientBindingError(&pgconn.PgError{Code: code}) {
			t.Fatal(code)
		}
	}
	if transientBindingError(&pgconn.PgError{Code: "23505"}) || !transientBindingError(io.EOF) || transientBindingError(errBoom) {
		t.Fatal("classification")
	}
	if retryBindingTransport(context.Canceled) || retryBindingTransport(context.DeadlineExceeded) {
		t.Fatal("retrying cancellation")
	}
	c, _ := consumerFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.retry(ctx, nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	c.RetryDelay = time.Hour
	if err := c.retry(ctx, func(context.Context) error { cancel(); return errBoom }, retryBindingTransport); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestBindingConsumerExistingApplyPathDuplicateStaleAndGap(t *testing.T) {
	tests := []struct {
		name    string
		steps   []step
		kind    string
		version int
		want    error
	}{
		{"duplicate", []step{{rows: 1}, {rows: 0}, {scan: setBool(true)}}, eventRegistered, 1, nil},
		{"changed ID", []step{{rows: 1}, {rows: 0}, {scan: setBool(false)}}, eventRegistered, 1, nil},
		{"stale", []step{{rows: 1}, {rows: 1}, {scan: setInt(1)}, {scan: setInt64(4)}, {rows: 0}}, eventStatusChanged, 3, nil},
		{"gap", []step{{rows: 1}, {rows: 1}, {scan: setInt(1)}, {scan: setInt64(1)}}, eventStatusChanged, 3, ErrVersionGap},
		{"missing", []step{{rows: 1}, {rows: 1}, {err: pgx.ErrNoRows}}, eventStatusChanged, 2, ErrBindingMissing},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, m := consumerFixture(t)
			e, _ := ParseInventoryEvent(m.Value)
			m.Value = canonicalBinding(eventSpec{id: e.EventID, tenant: e.TenantID, device: e.DeviceID, kind: tt.kind, version: tt.version})
			c.Apply = func(ctx context.Context, b []byte) (BindingOutcome, error) {
				return ApplyInventoryEvent(ctx, scriptDB{tt.steps}, b)
			}
			quarantined, committed := false, false
			c.Sink = bindingSinkFunc(func(context.Context, BindingRecord) error { quarantined = true; return nil })
			m.Commit = func(context.Context) error { committed = true; return nil }
			if err := c.process(context.Background(), m); !errors.Is(err, tt.want) {
				t.Fatal(err)
			}
			if committed != (tt.want == nil) || quarantined != (tt.name == "changed ID") {
				t.Fatal("wrong disposition")
			}
		})
	}
}

func canonicalBinding(e eventSpec) []byte {
	var event map[string]any
	_ = json.Unmarshal(e.json(), &event)
	event["occurred_at"] = ingNow.Format(time.RFC3339Nano)
	event["correlation_id"], event["causation_id"] = randomUUID(), randomUUID()
	event["traceparent"] = ingTraceparent
	body, _ := json.Marshal(event)
	return body
}

func assertBindingRows(t *testing.T, tenant string, want int) {
	for _, table := range []string{"device_bindings", "device_streams", "consumer_inbox"} {
		if n := adminInt(t, "SELECT count(*) FROM "+table+" WHERE tenant_id=$1", tenant); n != want {
			t.Fatalf("%s has %d rows", table, n)
		}
	}
}

func assertReplayedOnce(t *testing.T, c *BindingConsumer, m BindingMessage, db TxStarter, tenant string) {
	c.Apply = func(ctx context.Context, b []byte) (BindingOutcome, error) { return ApplyInventoryEvent(ctx, db, b) }
	commits := 0
	m.Commit = func(context.Context) error { commits++; return nil }
	for i := 0; i < 2; i++ {
		if err := c.process(context.Background(), m); err != nil {
			t.Fatal(err)
		}
	}
	if commits != 2 || adminInt(t, "SELECT count(*) FROM consumer_inbox WHERE tenant_id=$1", tenant) != 1 {
		t.Fatal("replay duplicated effect")
	}
}

func assertBindingHiddenFromOtherTenant(t *testing.T, db TxStarter, tenant string) {
	if err := WithTenant(context.Background(), db, randomUUID(), func(ctx context.Context, tx pgx.Tx) error {
		var n int
		err := tx.QueryRow(ctx, "SELECT count(*) FROM device_bindings WHERE tenant_id=$1", tenant).Scan(&n)
		if n != 0 {
			t.Fatal("cross-tenant binding visible")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBindingConsumerDatabaseCrashAndTenantIsolation(t *testing.T) {
	db := pooled(t, 4)
	for boundary := 1; boundary <= 4; boundary++ {
		t.Run(string(rune('0'+boundary)), func(t *testing.T) {
			c, m := consumerFixture(t)
			event, _ := ParseInventoryEvent(m.Value)
			fault := &ingFaultDB{TxStarter: db, failWrite: boundary, failCommit: boundary == 4}
			c.Apply = func(ctx context.Context, b []byte) (BindingOutcome, error) { return ApplyInventoryEvent(ctx, fault, b) }
			m.Commit = func(context.Context) error { t.Fatal("fault committed Kafka offset"); return nil }
			if err := c.process(context.Background(), m); !errors.Is(err, errIngFault) {
				t.Fatal(err)
			}
			want := 0
			if boundary == 4 {
				want = 1
			}
			assertBindingRows(t, event.TenantID, want)
			assertReplayedOnce(t, c, m, db, event.TenantID)
			assertBindingHiddenFromOtherTenant(t, db, event.TenantID)
		})
	}
}

func TestBindingConsumerSchemaBoundary(t *testing.T) {
	c, m := consumerFixture(t)
	if _, err := loadBindingSchemas(t.TempDir()); err == nil {
		t.Fatal("missing schemas accepted")
	}
	for _, body := range [][]byte{[]byte("{"), []byte(`{"event_type":"wrong"}`), []byte(`{"event_type":"device.registered"}`)} {
		if err := c.Validate(body); err == nil {
			t.Fatal("invalid schema accepted")
		}
	}
	for _, field := range []string{"correlation_id", "traceparent"} {
		var event map[string]any
		_ = json.Unmarshal(m.Value, &event)
		value := "00000000-0000-0000-0000-000000000000"
		if field == "traceparent" {
			value = "00-00000000000000000000000000000000-0000000000000000-01"
		}
		event[field] = value
		body, _ := json.Marshal(event)
		if err := c.Validate(body); err == nil {
			t.Fatal("nil identity accepted")
		}
	}
	var event map[string]any
	_ = json.Unmarshal(m.Value, &event)
	delete(event, "occurred_at")
	m.Value, _ = json.Marshal(event)
	published := false
	c.Sink = bindingSinkFunc(func(context.Context, BindingRecord) error { published = true; return nil })
	m.Commit = func(context.Context) error {
		if !published {
			t.Fatal("offset before quarantine")
		}
		return nil
	}
	if err := c.process(context.Background(), m); err != nil {
		t.Fatal(err)
	}
}
