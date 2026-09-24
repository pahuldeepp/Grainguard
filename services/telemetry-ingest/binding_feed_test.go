package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func feedFixture() (*BindingFeed, BindingMessage) {
	f := &BindingFeed{MaxStale: 5 * time.Minute, Partitions: 6, Now: func() time.Time { return ingNow }}
	cp := FeedCheckpoint{EventType: bindingHeartbeat, SchemaVersion: 1, SourceTime: ingNow, SourcePosition: "123", RawPosition: 10, Partitions: 6}
	body, _ := json.Marshal(cp)
	return f, BindingMessage{Topic: bindingTopic, Key: []byte(bindingHeartbeatKey), Value: body, Offset: 11}
}
func feedStep(count int, oldest, newest *time.Time) step {
	return step{scan: func(d []any) { *(d[0].(*int)) = count; *(d[1].(**time.Time)) = oldest; *(d[2].(**time.Time)) = newest }}
}

func TestBindingFeedFreshStaleDisabledMissingAndClockSkew(t *testing.T) {
	old := ingNow.Add(-6 * time.Minute)
	future := ingNow.Add(6 * time.Second)
	cases := []struct {
		name            string
		step            step
		disabled, stale bool
	}{
		{"fresh", feedStep(6, &ingNow, &ingNow), false, false},
		{"boundary", feedStep(6, ptrTime(ingNow.Add(-5*time.Minute+bindingClockSkew)), &ingNow), false, false},
		{"stale", feedStep(6, &old, &old), false, true},
		{"missing", feedStep(5, &ingNow, &ingNow), false, true},
		{"empty", feedStep(6, nil, nil), false, true},
		{"future", feedStep(6, &ingNow, &future), false, true},
		{"database", step{err: errBoom}, false, true},
		{"disabled", step{}, true, false},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			f, _ := feedFixture()
			if tt.disabled {
				f.MaxStale = 0
			}
			err := f.Check(context.Background(), &scriptTx{steps: []step{tt.step}})
			if tt.stale {
				ingMustReject(t, err, bindingFeedStale, 503)
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}
func ptrTime(value time.Time) *time.Time { return &value }

func TestBindingFeedRejectsMalformedCheckpoint(t *testing.T) {
	f, m := feedFixture()
	tests := []func(*BindingMessage){
		func(m *BindingMessage) { m.Value = []byte("{") },
		func(m *BindingMessage) { m.Value = append(m.Value, []byte(" {}")...) },
		func(m *BindingMessage) { m.Topic = "wrong" },
		func(m *BindingMessage) { m.Key = nil },
		func(m *BindingMessage) { m.Partition = -1 },
		func(m *BindingMessage) { m.Partition = 6 },
		func(m *BindingMessage) { m.Offset = -1 },
	}
	for _, change := range tests {
		bad := m
		bad.Value = append([]byte(nil), m.Value...)
		change(&bad)
		if _, err := parseCheckpoint(bad, 6); err == nil {
			t.Fatal("accepted malformed checkpoint")
		}
	}
	badPosition := m
	badPosition.Value = []byte(strings.Replace(string(m.Value), `"source_position":"123"`, `"source_position":"bad"`, 1))
	if _, err := parseCheckpoint(badPosition, 6); err == nil {
		t.Fatal("invalid source position accepted")
	}
	var cp FeedCheckpoint
	_ = json.Unmarshal(m.Value, &cp)
	changes := []func(*FeedCheckpoint){
		func(c *FeedCheckpoint) { c.EventType = "wrong" }, func(c *FeedCheckpoint) { c.SchemaVersion = 2 },
		func(c *FeedCheckpoint) { c.SourceTime = time.Time{} },
		func(c *FeedCheckpoint) { c.RawPosition = -1 }, func(c *FeedCheckpoint) { c.SourcePosition = "" },
		func(c *FeedCheckpoint) { c.SourcePosition = strings.Repeat("1", 129) }, func(c *FeedCheckpoint) { c.Partitions = 7 },
	}
	for _, change := range changes {
		bad := cp
		change(&bad)
		message := m
		message.Value, _ = json.Marshal(bad)
		if err := f.Heartbeat(context.Background(), message); !errors.Is(err, ErrInvalidEvent) {
			t.Fatal(err)
		}
	}
}

func TestBindingFeedPersistenceAndMetricsFailures(t *testing.T) {
	f, m := feedFixture()
	f.DB = scriptDB{[]step{{rows: 1}}}
	if err := f.Heartbeat(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	f.DB = scriptDB{[]step{{err: errBoom}}}
	if err := f.Heartbeat(context.Background(), m); !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
	f.DB = failingDB{}
	if err := f.Heartbeat(context.Background(), m); err == nil {
		t.Fatal("begin succeeded")
	}
	if !strings.Contains(f.metrics(context.Background()), "+Inf") {
		t.Fatal("missing evidence rendered fresh")
	}
	f.DB = scriptDB{[]step{feedStep(6, &ingNow, &ingNow)}}
	if !strings.Contains(f.metrics(context.Background()), "binding_feed_age_seconds 5\n") {
		t.Fatal("age not conservative")
	}
	f.DB = scriptDB{[]step{{err: errBoom}}}
	if !strings.Contains(f.metrics(context.Background()), "+Inf") {
		t.Fatal("read failure rendered fresh")
	}
}

func TestBindingConsumerCheckpointDisposition(t *testing.T) {
	for _, failure := range []error{nil, ErrInvalidEvent, errBoom} {
		c, _ := consumerFixture(t)
		_, m := feedFixture()
		committed := false
		c.Heartbeat = func(context.Context, BindingMessage) error { return failure }
		c.Sink = bindingSinkFunc(func(context.Context, BindingRecord) error { return nil })
		m.Commit = func(context.Context) error { committed = true; return nil }
		err := c.process(context.Background(), m)
		if failure == errBoom {
			if !errors.Is(err, errBoom) || committed {
				t.Fatal("checkpoint failure committed")
			}
		} else if err != nil || !committed {
			t.Fatal(err)
		}
	}
	c, _ := consumerFixture(t)
	_, m := feedFixture()
	c.Heartbeat = func(context.Context, BindingMessage) error { return ErrInvalidEvent }
	c.Sink = bindingSinkFunc(func(context.Context, BindingRecord) error { return errBoom })
	if err := c.process(context.Background(), m); !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
}

func TestBindingFeedAdmissionAfterReceiptAndBinding(t *testing.T) {
	f, _ := feedFixture()
	steps := append(ingHappySteps(bindingActive)[:4], feedStep(0, nil, nil))
	g := ingScripted(steps)
	g.feed = f
	_, err := ingScriptedIngest(g)
	ingMustReject(t, err, bindingFeedStale, 503)
	steps = ingHappySteps(bindingActive)
	steps = append(steps[:4], append([]step{feedStep(6, &ingNow, &ingNow)}, steps[4:]...)...)
	g = ingScripted(steps)
	g.feed = f
	if _, err := ingScriptedIngest(g); err != nil {
		t.Fatal(err)
	}
	// A receipt returns before either the disabled binding or freshness query.
	steps = ingHappySteps("disabled")[:3]
	steps[2] = step{scan: func(d []any) { *(d[0].(*[]byte)) = []byte(`{"stream_version":"9"}`); *(d[1].(*bool)) = true }}
	g = ingScripted(steps)
	g.feed = f
	if result, err := ingScriptedIngest(g); err != nil || result.StreamVersion != "9" {
		t.Fatal(result, err)
	}
}

func TestBindingFeedConfig(t *testing.T) {
	for _, raw := range []string{"", "0", "2m", "-1m", "bad"} {
		bound, err := loadBindingFeedBound(cfgEnv(map[string]string{"INGEST_BINDING_FEED_MAX_STALE": raw}))
		if raw == "bad" || raw == "-1m" {
			if err == nil {
				t.Fatal(raw)
			}
		} else if err != nil || (raw == "0" && bound != 0) {
			t.Fatal(bound, err)
		}
	}
}

func TestBindingFeedDatabaseMonotonicityAndPrivileges(t *testing.T) {
	db := direct(t, 2)
	f, m := feedFixture()
	f.DB = db
	// Use a dedicated partition outside the operational six; clean it up afterward.
	f.Partitions = 1001
	m.Partition = 1000
	var cp FeedCheckpoint
	_ = json.Unmarshal(m.Value, &cp)
	cp.Partitions = f.Partitions
	m.Value, _ = json.Marshal(cp)
	admin := adminConn(t, "greenguard_telemetry")
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DELETE FROM binding_feed_checkpoints WHERE partition_id=1000")
	})
	if err := f.Heartbeat(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	m.Offset++
	cp.RawPosition--
	cp.SourceTime = cp.SourceTime.Add(time.Second)
	m.Value, _ = json.Marshal(cp)
	if err := f.Heartbeat(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	var raw int64
	if err := db.QueryRow(context.Background(), "SELECT raw_position FROM binding_feed_checkpoints WHERE partition_id=1000").Scan(&raw); err != nil || raw != 10 {
		t.Fatal(raw, err)
	}
	for _, sql := range []string{"DELETE FROM binding_feed_checkpoints", "UPDATE binding_feed_checkpoints SET partition_id=1002"} {
		_, err := db.Exec(context.Background(), sql)
		if sqlState(err) != "42501" {
			t.Fatal(err)
		}
	}
	var rls bool
	if err := adminConn(t, "greenguard_telemetry").QueryRow(context.Background(), "SELECT relrowsecurity FROM pg_class WHERE relname='binding_feed_checkpoints'").Scan(&rls); err != nil || rls {
		t.Fatal(rls, err)
	}
}

func TestBindingFeedCommitFailureNeverCommitsKafkaOffset(t *testing.T) {
	f, m := feedFixture()
	tx := &fakeTx{commitErr: errBoom}
	f.DB = &fakeDB{tx: tx}
	c, _ := consumerFixture(t)
	c.Heartbeat = f.Heartbeat
	m.Commit = func(context.Context) error { t.Fatal("checkpoint commit failure advanced offset"); return nil }
	if err := c.process(context.Background(), m); !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
	if tx.commits != 1 || tx.rollbacks != 1 {
		t.Fatalf("commit=%d rollback=%d", tx.commits, tx.rollbacks)
	}
}
