package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var errBoom = errors.New("boom")

// step is the canned result of one statement in the order the code issues them.
type step struct {
	rows int64
	err  error
	scan func(dest []any)
}

type scriptTx struct {
	pgx.Tx
	steps []step
	n     int
}

func (s *scriptTx) next() step {
	st := s.steps[s.n]
	s.n++
	return st
}

func (s *scriptTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	st := s.next()
	return pgconn.NewCommandTag(fmt.Sprintf("INSERT 0 %d", st.rows)), st.err
}

func (s *scriptTx) QueryRow(context.Context, string, ...any) pgx.Row { return scriptRow{s.next()} }
func (s *scriptTx) Commit(context.Context) error                     { return nil }
func (s *scriptTx) Rollback(context.Context) error                   { return nil }

type scriptRow struct{ st step }

func (r scriptRow) Scan(dest ...any) error {
	if r.st.err != nil {
		return r.st.err
	}
	r.st.scan(dest)
	return nil
}

type scriptDB struct{ steps []step }

func (d scriptDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	return &scriptTx{steps: append([]step(nil), d.steps...)}, nil
}

func setInt(v int) func([]any)     { return func(d []any) { *(d[0].(*int)) = v } }
func setInt64(v int64) func([]any) { return func(d []any) { *(d[0].(*int64)) = v } }
func setBool(v bool) func([]any)   { return func(d []any) { *(d[0].(*bool)) = v } }

func TestEveryDatabaseFailureIsReportedAndNothingIsAppliedTwice(t *testing.T) {
	tenant, device := randomUUID(), randomUUID()
	flows := []struct {
		name  string
		spec  eventSpec
		steps []step
	}{
		{"register a new device", eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1},
			[]step{{rows: 1}, {rows: 1}, {err: pgx.ErrNoRows}, {rows: 1}, {rows: 1}}},
		{"binding change", eventSpec{kind: "device.binding_changed", tenant: tenant, device: device, version: 2},
			[]step{{rows: 1}, {rows: 1}, {scan: setInt(1)}, {scan: setInt64(1)}, {rows: 1}}},
		{"status change", eventSpec{kind: "device.status_changed", tenant: tenant, device: device, version: 2, status: "disabled"},
			[]step{{rows: 1}, {rows: 1}, {scan: setInt(1)}, {scan: setInt64(1)}, {rows: 1}}},
		{"duplicate delivery", eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1},
			[]step{{rows: 1}, {rows: 0}, {scan: setBool(true)}}},
	}
	for _, flow := range flows {
		if _, err := ApplyInventoryEvent(context.Background(), scriptDB{flow.steps}, flow.spec.json()); err != nil {
			t.Fatalf("%s: the scripted happy path must succeed: %v", flow.name, err)
		}
		for i := range flow.steps {
			steps := append([]step(nil), flow.steps...)
			steps[i] = step{err: errBoom}
			outcome, err := ApplyInventoryEvent(context.Background(), scriptDB{steps}, flow.spec.json())
			if !errors.Is(err, errBoom) || outcome != "" {
				t.Errorf("%s, statement %d failing: got %q, %v", flow.name, i+1, outcome, err)
			}
		}
	}
}

func TestParseRejectsAVersionThatFitsTheFormatButOverflowsInt64(t *testing.T) {
	data := []byte(strings.NewReplacer("VERSION", "9999999999999999999").Replace(
		`{"event_id":"` + randomUUID() + `","event_type":"device.status_changed","schema_version":1,` +
			`"tenant_id":"` + randomUUID() + `","aggregate_type":"device","aggregate_id":"DEV","aggregate_version":"VERSION",` +
			`"payload":{"device_id":"DEV","status":"active","binding_version":"VERSION"}}`))
	device := randomUUID()
	data = []byte(strings.ReplaceAll(string(data), "DEV", device))
	if _, err := ParseInventoryEvent(data); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("got %v", err)
	}
}
