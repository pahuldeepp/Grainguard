package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"reflect"
	"strings"
	"testing"
	"time"
)

type scriptedTx struct {
	pgx.Tx
	step, failAt, commits, rollbacks int
	queries                          []string
	args                             [][]any
	row                              func(string) rowResult
	events                           []map[string]any
	inboxDuplicate                   bool
	historySkipped                   bool
	queryErr, rowsErr                error
}
type rowResult struct {
	values []any
	err    error
}

func (r rowResult) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, v := range r.values {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(v))
	}
	return nil
}
func (s *scriptedTx) record(q string, args []any) error {
	s.step++
	s.queries = append(s.queries, q)
	s.args = append(s.args, args)
	if s.step == s.failAt {
		return errTest
	}
	return nil
}
func (s *scriptedTx) Exec(_ context.Context, q string, args ...any) (pgconn.CommandTag, error) {
	err := s.record(q, args)
	tag := "INSERT 0 1"
	if (s.inboxDuplicate && strings.Contains(q, "INSERT INTO consumer_inbox")) || (s.historySkipped && strings.Contains(q, "INSERT INTO reading_history")) {
		tag = "INSERT 0 0"
	}
	return pgconn.NewCommandTag(tag), err
}
func (s *scriptedTx) QueryRow(_ context.Context, q string, args ...any) pgx.Row {
	if err := s.record(q, args); err != nil {
		return rowResult{err: err}
	}
	if s.row != nil {
		return s.row(q)
	}
	return standardRow(q)
}
func standardRow(q string) rowResult {
	switch {
	case strings.Contains(q, "RETURNING shard_incarnation::text"):
		return rowResult{values: []any{testTenant, "1", "1"}}
	case strings.Contains(q, "SELECT max_seen"):
		return rowResult{values: []any{int64(0)}}
	case strings.Contains(q, "SELECT COALESCE"):
		return rowResult{values: []any{int64(1)}}
	case strings.Contains(q, "SELECT reading_id"):
		return rowResult{values: []any{testTenant}}
	case strings.Contains(q, "SELECT event="):
		return rowResult{values: []any{true}}
	}
	return rowResult{err: pgx.ErrNoRows}
}
func (s *scriptedTx) Query(_ context.Context, q string, args ...any) (pgx.Rows, error) {
	if err := s.record(q, args); err != nil {
		return nil, err
	}
	return &eventRows{events: s.events, err: s.rowsErr}, s.queryErr
}
func (s *scriptedTx) Commit(context.Context) error   { s.commits++; return s.record("COMMIT", nil) }
func (s *scriptedTx) Rollback(context.Context) error { s.rollbacks++; return nil }

type eventRows struct {
	pgx.Rows
	events []map[string]any
	pos    int
	err    error
	closed bool
}

func (r *eventRows) Next() bool {
	if r.pos >= len(r.events) {
		return false
	}
	r.pos++
	return true
}
func (r *eventRows) Scan(dest ...any) error {
	b, _ := json.Marshal(r.events[r.pos-1])
	*(dest[0].(*[]byte)) = b
	return nil
}
func (r *eventRows) Close()     { r.closed = true }
func (r *eventRows) Err() error { return r.err }

type scriptedDB struct{ tx *scriptedTx }

func (d scriptedDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) { return d.tx, nil }
func inventory(t *testing.T, kind string, v string) map[string]any {
	e := validEvent(t)
	e[fieldType] = kind
	e[fieldAggregateType] = "device"
	e[fieldVersion] = v
	e[fieldPayload] = map[string]any{fieldDevice: e[fieldAggregate], fieldBinding: v, "site_id": testTenant, "bin_id": nil, "serial_number": "SN", "status": "active"}
	return e
}
func TestStoreAtomicFailureBoundaries(t *testing.T) {
	for _, kind := range []string{typeTelemetry, typeRegistered} {
		e := validEvent(t)
		if kind == typeRegistered {
			e = inventory(t, kind, "1")
		}
		m := message(e)
		baseline := &scriptedTx{events: []map[string]any{e}}
		if err := (&Store{DB: scriptedDB{baseline}}).Apply(context.Background(), m, e); err != nil {
			t.Fatal(err)
		}
		if baseline.commits != 1 {
			t.Fatal("not committed")
		}
		for n := 1; n <= baseline.step; n++ {
			tx := &scriptedTx{failAt: n, events: []map[string]any{e}}
			err := (&Store{DB: scriptedDB{tx}}).Apply(context.Background(), m, e)
			if !errors.Is(err, errTest) {
				t.Fatalf("%s boundary %d: %v", kind, n, err)
			}
			if n < baseline.step && (tx.commits != 0 || tx.rollbacks != 1) {
				t.Fatalf("partial effect boundary %d", n)
			}
		}
	}
}
func TestInboxSemanticDuplicateAndCollision(t *testing.T) {
	e := validEvent(t)
	for _, equal := range []bool{true, false} {
		tx := &scriptedTx{inboxDuplicate: true, row: func(string) rowResult { return rowResult{values: []any{equal}} }}
		err := (&Store{DB: scriptedDB{tx}}).Apply(context.Background(), message(e), e)
		want := ErrConflict
		if equal {
			want = ErrDuplicate
		}
		if !errors.Is(err, want) || tx.commits != 0 || tx.rollbacks != 1 || len(tx.queries) != 5 {
			t.Fatal(err, tx.queries)
		}
	}
}
func TestGapSplitShrinkClose(t *testing.T) {
	for _, v := range []int64{1, 2, 3} {
		tx := &scriptedTx{row: func(string) rowResult { return rowResult{values: []any{int64(1), int64(3)}} }}
		args := []any{testTenant, testTenant, streamTelemetry}
		if err := updateGaps(context.Background(), tx, args, 4, v); err != nil {
			t.Fatal(err)
		}
		want := 3
		if v == 2 {
			want = 4
		}
		if tx.step != want {
			t.Fatal(v, tx.step)
		}
		for fail := 1; fail <= want; fail++ {
			bad := &scriptedTx{failAt: fail, row: tx.row}
			if err := updateGaps(context.Background(), bad, args, 4, v); !errors.Is(err, errTest) {
				t.Fatal(v, fail, err)
			}
		}
	}
	tx := &scriptedTx{}
	if err := updateGaps(context.Background(), tx, []any{testTenant, testTenant, streamTelemetry}, 0, 42); err != nil || tx.args[0][3] != int64(1) || tx.args[0][4] != int64(41) {
		t.Fatal(err, tx.args)
	}
}
func TestFoldInventoryChanges(t *testing.T) {
	for _, kind := range []string{typeRegistered, typeBinding, typeStatus, "unknown"} {
		e := inventory(t, kind, "2")
		tx := &scriptedTx{}
		err := foldInventory(context.Background(), tx, e)
		if (err != nil) != (kind == "unknown") {
			t.Fatal(kind, err)
		}
		if kind == "unknown" {
			continue
		}
		for n := 1; n <= 2; n++ {
			if err := foldInventory(context.Background(), &scriptedTx{failAt: n}, e); !errors.Is(err, errTest) {
				t.Fatal(kind, n, err)
			}
		}
	}
}
func TestInventoryReadFailures(t *testing.T) {
	e := inventory(t, typeRegistered, "1")
	for _, tx := range []*scriptedTx{{queryErr: errTest}, {rowsErr: errTest}} {
		if err := applyInventory(context.Background(), tx, e, 1); !errors.Is(err, errTest) {
			t.Fatal(err)
		}
	}
}
func TestCheckpointPersistenceAndFreshness(t *testing.T) {
	m := checkpointMessage()
	s := &Store{DB: scriptedDB{&scriptedTx{}}}
	if err := s.Heartbeat(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	m.Value = []byte("bad")
	if !errors.Is(s.Heartbeat(context.Background(), m), ErrCheckpoint) {
		t.Fatal("bad accepted")
	}
	assertHeartbeatStatementFailures(t)
	now := time.Now().Add(-time.Minute)
	assertFeedAgeCounts(t, now)
	tx := &scriptedTx{row: func(q string) rowResult {
		if strings.Contains(q, "SELECT count") {
			return rowResult{values: []any{6, &now, &now}}
		}
		return rowResult{values: []any{now, "42", "0", true, true}}
	}}
	f, err := (&Store{DB: scriptedDB{tx}}).Freshness(context.Background(), testTenant, testTenant)
	if err != nil || !f.HasKnownGap || !f.InventoryHasKnownGap || !f.BindingFeedFresh {
		t.Fatal(f, err)
	}
	if _, err = (&Store{DB: &failingDB{}}).Freshness(context.Background(), testTenant, testTenant); err == nil {
		t.Fatal("missing error")
	}
	if number(nil) != nil || number(json.Number("1.5")) != 1.5 {
		t.Fatal("nullable measure")
	}
}

// Every heartbeat statement failure is returned, not swallowed.
func assertHeartbeatStatementFailures(t *testing.T) {
	t.Helper()
	for n := 1; n <= 3; n++ {
		tx := &scriptedTx{failAt: n}
		if err := (&Store{DB: scriptedDB{tx}}).Heartbeat(context.Background(), checkpointMessage()); !errors.Is(err, errTest) {
			t.Fatal(n, err)
		}
	}
}

// FeedAge fails unless all six partitions have checkpoints, and fails when the DB is down.
func assertFeedAgeCounts(t *testing.T, now time.Time) {
	t.Helper()
	for _, count := range []int{0, 6} {
		tx := &scriptedTx{row: func(string) rowResult { return rowResult{values: []any{count, &now, &now}} }}
		age, err := (&Store{DB: scriptedDB{tx}}).FeedAge(context.Background())
		if (err == nil) != (count == 6) {
			t.Fatal(err)
		}
		if count == 6 && age < time.Minute {
			t.Fatal(age)
		}
	}
	if _, err := (&Store{DB: &failingDB{}}).FeedAge(context.Background()); err == nil {
		t.Fatal("db unavailable")
	}
}

func checkpointMessage() Message {
	b, _ := json.Marshal(FeedCheckpoint{EventType: bindingHeartbeat, SchemaVersion: 1, SourceTime: time.Now().Add(-time.Minute), SourcePosition: "100", RawPosition: 1, Partitions: 6})
	return Message{Topic: topicInventory, Key: []byte(bindingHeartbeatKey), Value: b, Offset: 1}
}
func TestCheckpointValidation(t *testing.T) {
	m := checkpointMessage()
	if _, err := parseCheckpoint(m, 6); err != nil {
		t.Fatal(err)
	}
	mutations := []func(*Message){func(m *Message) { m.Value = []byte("{") }, func(m *Message) { m.Value = append(m.Value, []byte(" {}")...) }, func(m *Message) { m.Topic = topicTelemetry }, func(m *Message) { m.Partition = 6 }, func(m *Message) { m.Offset = -1 }}
	for _, fn := range mutations {
		m := checkpointMessage()
		fn(&m)
		if _, err := parseCheckpoint(m, 6); err == nil {
			t.Fatal(string(m.Value))
		}
	}
	for _, pair := range []struct {
		k string
		v any
	}{{"source_position", "0"}, {"source_position", strings.Repeat("1", 129)}, {"source_time", "0001-01-01T00:00:00Z"}, {"raw_position", -1}, {"partitions", 5}, {"extra", 1}, {"schema_version", 2}} {
		m := checkpointMessage()
		var b map[string]any
		_ = json.Unmarshal(m.Value, &b)
		b[pair.k] = pair.v
		m.Value, _ = json.Marshal(b)
		if _, err := parseCheckpoint(m, 6); err == nil {
			t.Fatal(pair)
		}
	}
	now := time.Now()
	if minTime(now, now.Add(time.Second)) != now || minTime(now.Add(time.Second), now) != now {
		t.Fatal("clock clamp")
	}
}

func TestInboxUsesJSONTextWithUnnamedQueries(t *testing.T) {
	tx := &scriptedTx{}
	e := validEvent(t)
	m := message(e)
	if err := insertInbox(context.Background(), tx, m, e); err != nil {
		t.Fatal(err)
	}
	if body, ok := tx.args[0][6].(string); !ok || body != string(m.Value) {
		t.Fatal("JSON must be text, not bytea, in QueryExecModeExec")
	}
}

func TestHistoryMetricCountsCommittedLateReadingsOnly(t *testing.T) {
	e := validEvent(t)
	for _, fail := range []bool{false, true} {
		tx := &scriptedTx{historySkipped: true}
		store := &Store{DB: scriptedDB{tx}}
		if fail {
			tx.failAt = 15
		}
		err := store.Apply(context.Background(), message(e), e)
		if (err != nil) != fail {
			t.Fatal(err)
		}
		want := uint64(1)
		if fail {
			want = 0
		}
		if store.HistoryOutOfWindow.Load() != want {
			t.Fatal("counted rolled back effect")
		}
		tx.failAt = 0
		tx.inboxDuplicate = true
		if err = store.Apply(context.Background(), message(e), e); !errors.Is(err, ErrDuplicate) {
			t.Fatal(err)
		}
		if store.HistoryOutOfWindow.Load() != want {
			t.Fatal("duplicate counted")
		}
	}
}
func TestRLSIsHardUncommittedFailure(t *testing.T) {
	p := testProcessor(t)
	denial := &pgconn.PgError{Code: "42501"}
	p.Apply = func(context.Context, Message, map[string]any) error { return denial }
	m := message(validEvent(t))
	committed := false
	m.Commit = func(context.Context) error { committed = true; return nil }
	if err := p.process(context.Background(), m); !errors.Is(err, denial) {
		t.Fatal(err)
	}
	if committed || p.Quarantined.Load() != 0 || p.Retries.Load() != 0 {
		t.Fatal("RLS failure acknowledged or retried")
	}
	if databaseReason(&pgconn.PgError{Code: "55000"}) != "" {
		t.Fatal("partition outage quarantined")
	}
}
