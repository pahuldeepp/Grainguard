package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestFutureCheckpointClampedAndCommitted(t *testing.T) {
	for _, delta := range []time.Duration{-time.Second, 0, time.Second, time.Minute} {
		t.Run(delta.String(), func(t *testing.T) {
			f, m := feedFixture()
			var cp FeedCheckpoint
			_ = json.Unmarshal(m.Value, &cp)
			cp.SourceTime = ingNow.Add(delta)
			m.Value, _ = json.Marshal(cp)
			tx := &fakeTx{}
			f.DB = &fakeDB{tx: tx}
			c, _ := consumerFixture(t)
			c.Heartbeat = f.Heartbeat
			committed := false
			m.Commit = func(context.Context) error { committed = true; return nil }
			if err := c.process(context.Background(), m); err != nil {
				t.Fatal(err)
			}
			want, skew := cp.SourceTime, uint64(0)
			if delta > 0 {
				want, skew = ingNow, 1
			}
			if tx.execArgs[1] != want || f.ClockSkew.Load() != skew || !committed || c.Quarantined.Load() != 0 {
				t.Fatal(tx.execArgs, f.ClockSkew.Load(), committed)
			}
			f.DB = scriptDB{[]step{feedStep(6, &ingNow, &ingNow)}}
			if !strings.Contains(f.metrics(context.Background()), fmt.Sprintf("binding_feed_clock_skew_total %d\n", skew)) {
				t.Fatal("missing skew metric")
			}
		})
	}
}

const dataExceptionCode = "22003"
const constraintViolationCode = "23503"

type rejectedCase struct {
	heartbeat    bool
	code         string
	publishFails bool
}

func TestDatabaseRejectedQuarantineCommitOrdering(t *testing.T) {
	for _, tc := range []rejectedCase{
		{false, dataExceptionCode, false}, {false, dataExceptionCode, true},
		{false, constraintViolationCode, false}, {false, constraintViolationCode, true},
		{true, dataExceptionCode, false}, {true, dataExceptionCode, true},
		{true, constraintViolationCode, false}, {true, constraintViolationCode, true},
	} {
		t.Run(fmt.Sprint(tc), func(t *testing.T) { checkRejectedDatabase(t, tc) })
	}
}

func checkRejectedDatabase(t *testing.T, tc rejectedCase) {
	t.Helper()
	c, m := consumerFixture(t)
	calls, published, committed := 0, 0, false
	failure := fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: tc.code})
	apply := func() error { calls++; return failure }
	c.Apply = func(context.Context, []byte) (BindingOutcome, error) { return "", apply() }
	if tc.heartbeat {
		_, m = feedFixture()
		c.Heartbeat = func(context.Context, BindingMessage) error { return apply() }
	}
	c.Sink = rejectedSink(t, tc.publishFails, &published)
	m.Commit = func(context.Context) error {
		if published != 1 {
			t.Fatal("commit before confirmed quarantine")
		}
		committed = true
		return nil
	}
	err := c.process(context.Background(), m)
	if calls != 1 || committed == tc.publishFails {
		t.Fatal(calls, committed, err)
	}
	checkQuarantineResult(t, c, err, tc)
}

func rejectedSink(t *testing.T, fails bool, published *int) BindingSink {
	t.Helper()
	return bindingSinkFunc(func(_ context.Context, r BindingRecord) error {
		var q struct{ Reason string }
		if err := json.Unmarshal(r.Value, &q); err != nil || q.Reason != reasonDBRejected {
			t.Fatal(string(r.Value), err)
		}
		*published++
		if fails {
			return errBoom
		}
		return nil
	})
}

func checkQuarantineResult(t *testing.T, c *BindingConsumer, err error, tc rejectedCase) {
	t.Helper()
	if tc.publishFails {
		if !errors.Is(err, errBoom) || c.Quarantined.Load() != 0 || c.HeartbeatQuarantined.Load() != 0 {
			t.Fatal(err)
		}
		return
	}
	if err != nil || c.Quarantined.Load() != 1 {
		t.Fatal(err)
	}
	if tc.heartbeat && !strings.Contains(c.metrics(), `binding_consumer_quarantine_total{reason="heartbeat"} 1`) {
		t.Fatal(c.metrics())
	}
}

func TestPermanentBindingErrorClassification(t *testing.T) {
	for _, err := range []error{nil, errBoom, &pgconn.PgError{Code: "22"}, &pgconn.PgError{Code: "40001"}, &pgconn.PgError{Code: "08006"}} {
		if permanentBindingError(err) {
			t.Fatal(err)
		}
	}
}

func TestCheckpointTransientExhaustionNeverCommits(t *testing.T) {
	c, _ := consumerFixture(t)
	_, m := feedFixture()
	calls := 0
	failure := &pgconn.PgError{Code: "40001"}
	c.Heartbeat = func(context.Context, BindingMessage) error { calls++; return failure }
	m.Commit = func(context.Context) error { t.Fatal("committed failed checkpoint"); return nil }
	if err := c.process(context.Background(), m); !errors.Is(err, failure) || calls != c.Attempts {
		t.Fatal(calls, err)
	}
}

func TestCheckpointTableIntentionallyGlobalMigration(t *testing.T) {
	raw, err := os.ReadFile("migrations/000004_binding_feed_checkpoints.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "CREATE TABLE binding_feed_checkpoints") || strings.Contains(string(raw), "tenant_id") {
		t.Fatal("checkpoint infrastructure state must not contain tenant data")
	}
}

func TestCheckpointTableIntentionallyGlobalDatabase(t *testing.T) {
	db := adminConn(t, "greenguard_telemetry")
	var columns, tenants int
	err := db.QueryRow(context.Background(), `SELECT count(*), count(*) FILTER (WHERE column_name='tenant_id')
 FROM information_schema.columns WHERE table_schema='public' AND table_name='binding_feed_checkpoints'`).Scan(&columns, &tenants)
	if err != nil || columns == 0 || tenants != 0 {
		t.Fatal(columns, tenants, err)
	}
}
