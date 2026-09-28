package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"greenguard.local/jobs-worker/migrations"
	"greenguard.local/jobs-worker/rabbit"
)

func randomUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func envOrSkip(t *testing.T, key string) string {
	t.Helper()
	v := os.Getenv(key)
	if v == "" {
		t.Skipf("%s is not set; local PostgreSQL test not run", key)
	}
	return v
}

func dbPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := openPool(context.Background(), envOrSkip(t, "JOBS_DIRECT_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// alertEvent builds a fresh tenant's critical alert.opened (three channels).
func alertEvent(t *testing.T, tenant string) AlertEvent {
	t.Helper()
	ev, err := ParseAlertEvent(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	ev.TenantID, ev.EventID = tenant, randomUUID()
	// Warning is the RabbitMQ path; critical alerts belong to the serverless path (Stage 10d).
	ev.Payload.Severity = "warning"
	ev.Payload.EpisodeID = randomUUID()
	ev.AggregateID = ev.Payload.EpisodeID
	return ev
}

func alertEventBytes(t *testing.T, ev AlertEvent) []byte {
	t.Helper()
	return mutate(t, func(m map[string]any) {
		m["tenant_id"] = ev.TenantID
		m["event_id"] = ev.EventID
		m["aggregate_id"] = ev.AggregateID
		m["payload"].(map[string]any)["episode_id"] = ev.Payload.EpisodeID
		m["payload"].(map[string]any)["severity"] = ev.Payload.Severity
	})
}

func countRows(t *testing.T, db TxStarter, tenant, sql string) int {
	t.Helper()
	var n int
	if err := WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, sql).Scan(&n)
	}); err != nil {
		t.Fatal(err)
	}
	return n
}

func intentStatus(t *testing.T, db TxStarter, tenant, id string) (string, int) {
	t.Helper()
	var status string
	var attempts int
	if err := WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT status, attempts FROM notification_intents WHERE intent_id = $1", id).Scan(&status, &attempts)
	}); err != nil {
		t.Fatal(err)
	}
	return status, attempts
}

type recordingPublisher struct {
	mu    sync.Mutex
	ids   []string
	err   error
	delay time.Duration
}

func (p *recordingPublisher) Publish(ctx context.Context, m rabbit.Message) error {
	time.Sleep(p.delay)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err != nil {
		return p.err
	}
	p.ids = append(p.ids, m.MessageID)
	return nil
}

// crashingDB simulates a process that dies after its work but before COMMIT.
type crashingDB struct{ inner TxStarter }

type crashingTx struct{ pgx.Tx }

func (c crashingDB) BeginTx(ctx context.Context, o pgx.TxOptions) (pgx.Tx, error) {
	tx, err := c.inner.BeginTx(ctx, o)
	return crashingTx{tx}, err
}

func (c crashingTx) Commit(ctx context.Context) error {
	_ = c.Tx.Rollback(ctx)
	return errors.New("simulated crash before commit")
}

var testPolicy = DispatchPolicy{MaxAttempts: 3, BaseBackoff: time.Millisecond, MaxBackoff: 10 * time.Millisecond, PublishTimeout: time.Second}

func TestRecordEventIsIdempotentAndTenantIsolated(t *testing.T) {
	db := dbPool(t)
	a, b := randomUUID(), randomUUID()
	ev := alertEvent(t, a)
	out, err := RecordEvent(context.Background(), db, ev, SourceRef{Topic: "t", Offset: 1})
	if err != nil || out.Duplicate || len(out.Intents) != 2 {
		t.Fatalf("%+v %v", out, err)
	}
	again, err := RecordEvent(context.Background(), db, ev, SourceRef{Topic: "t", Offset: 1})
	if err != nil || !again.Duplicate {
		t.Fatalf("redelivery not deduplicated: %+v %v", again, err)
	}
	// The same committed transition under a new event ID still yields the same intents.
	ev.EventID = randomUUID()
	if other, err := RecordEvent(context.Background(), db, ev, SourceRef{Topic: "t", Offset: 2}); err != nil || len(other.Intents) != 0 {
		t.Fatalf("second event created intents: %+v %v", other, err)
	}
	if n := countRows(t, db, a, "SELECT count(*) FROM notification_intents"); n != 2 {
		t.Fatalf("tenant a sees %d", n)
	}
	if n := countRows(t, db, b, "SELECT count(*) FROM notification_intents"); n != 0 {
		t.Fatalf("tenant b sees tenant a's intents: %d", n)
	}
	err = WithTenant(context.Background(), db, b, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "INSERT INTO inbox (tenant_id, event_id, event_type, source_topic, source_partition, source_offset) VALUES ($1, $2, 'alert.opened', 't', 0, 0)", a, randomUUID())
		return err
	})
	if err == nil {
		t.Fatal("tenant b wrote a row for tenant a")
	}
}

func TestCriticalTenantOwnsEscalationDelivery(t *testing.T) {
	db := dbPool(t)
	tenant := randomUUID()
	ev := alertEvent(t, tenant)
	ev.EventType, ev.Payload.Severity = eventEscalated, "critical"
	out, err := RecordEvent(context.Background(), db, ev, SourceRef{Topic: "t", Offset: 1})
	if err != nil || out.Duplicate || len(out.Intents) != 0 {
		t.Fatalf("critical event created local intents: %+v %v", out, err)
	}
	if n := countRows(t, db, tenant, "SELECT count(*) FROM inbox"); n != 1 {
		t.Fatalf("critical path must retain inbox evidence; got %d", n)
	}
	if n := countRows(t, db, tenant, "SELECT count(*) FROM notification_intents"); n != 0 {
		t.Fatalf("critical path created %d RabbitMQ intents", n)
	}
	ev.EventID, ev.Payload.Severity = randomUUID(), "warning"
	local, err := RecordEvent(context.Background(), db, ev, SourceRef{Topic: "t", Offset: 2})
	if err != nil || len(local.Intents) != 2 {
		t.Fatalf("warning must retain RabbitMQ delivery: %+v %v", local, err)
	}
}

func TestNoTenantContextSeesNothingAndCannotDelete(t *testing.T) {
	db := dbPool(t)
	a := randomUUID()
	if _, err := RecordEvent(context.Background(), db, alertEvent(t, a), SourceRef{}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(context.Background(), "SELECT count(*) FROM notification_intents").Scan(&n); err != nil || n != 0 {
		t.Fatalf("no-context read %d %v", n, err)
	}
	err := WithTenant(context.Background(), db, a, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "DELETE FROM notification_intents")
		return err
	})
	if err == nil {
		t.Fatal("runtime role may delete ledger rows")
	}
	if err := WithTenant(context.Background(), db, "bad", nil); !errors.Is(err, ErrInvalidTenant) {
		t.Fatal(err)
	}
}

func TestCrashBeforeCommitLeavesNothingThenRetrySucceeds(t *testing.T) {
	db := dbPool(t)
	a := randomUUID()
	ev := alertEvent(t, a)
	if _, err := RecordEvent(context.Background(), crashingDB{db}, ev, SourceRef{}); err == nil {
		t.Fatal("crash not reported")
	}
	if n := countRows(t, db, a, "SELECT count(*) FROM inbox") + countRows(t, db, a, "SELECT count(*) FROM notification_intents"); n != 0 {
		t.Fatalf("rolled-back work is visible: %d", n)
	}
	if out, err := RecordEvent(context.Background(), db, ev, SourceRef{}); err != nil || len(out.Intents) != 2 {
		t.Fatalf("%+v %v", out, err)
	}
}

func dueFor(t *testing.T, db TxStarter, tenant string) []DueRef {
	t.Helper()
	all, err := ScanDue(context.Background(), db, 10000)
	if err != nil {
		t.Fatal(err)
	}
	var mine []DueRef
	for _, r := range all {
		if r.TenantID == tenant {
			mine = append(mine, r)
		}
	}
	return mine
}

func TestConcurrentDispatchersPublishEachIntentOnce(t *testing.T) {
	db := dbPool(t)
	a := randomUUID()
	if _, err := RecordEvent(context.Background(), db, alertEvent(t, a), SourceRef{}); err != nil {
		t.Fatal(err)
	}
	refs := dueFor(t, db, a)
	pub := &recordingPublisher{delay: 50 * time.Millisecond}
	var published atomic.Int64
	var wg sync.WaitGroup
	for w := 0; w < 4; w++ {
		for _, ref := range refs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				out, _, err := DispatchOne(context.Background(), db, pub, testPolicy, ref)
				if err != nil {
					t.Error(err)
				}
				if out == OutcomePublished {
					published.Add(1)
				}
			}()
		}
	}
	wg.Wait()
	if published.Load() != 2 || len(pub.ids) != 2 || len(dueFor(t, db, a)) != 0 {
		t.Fatalf("published=%d ids=%v", published.Load(), pub.ids)
	}
	status, attempts := intentStatus(t, db, a, pub.ids[0])
	if status != "dispatched" || attempts != 1 {
		t.Fatalf("%s %d", status, attempts)
	}
}

func TestCrashAfterConfirmRepublishesSameMessageID(t *testing.T) {
	db := dbPool(t)
	a := randomUUID()
	out, err := RecordEvent(context.Background(), db, alertEvent(t, a), SourceRef{})
	if err != nil {
		t.Fatal(err)
	}
	pub := &recordingPublisher{}
	ref := DueRef{TenantID: a, IntentID: out.Intents[0]}
	if _, _, err := DispatchOne(context.Background(), crashingDB{db}, pub, testPolicy, ref); err == nil {
		t.Fatal("crash not reported")
	}
	if status, _ := intentStatus(t, db, a, ref.IntentID); status != "pending" {
		t.Fatalf("status after crash %s", status)
	}
	if o, _, err := DispatchOne(context.Background(), db, pub, testPolicy, ref); err != nil || o != OutcomePublished {
		t.Fatalf("%s %v", o, err)
	}
	if len(pub.ids) != 2 || pub.ids[0] != pub.ids[1] || pub.ids[0] != ref.IntentID {
		t.Fatalf("re-publish changed identity: %v", pub.ids)
	}
}

func TestPublishFailureBacksOffThenDeadLetters(t *testing.T) {
	db := dbPool(t)
	a := randomUUID()
	out, err := RecordEvent(context.Background(), db, alertEvent(t, a), SourceRef{})
	if err != nil {
		t.Fatal(err)
	}
	pub := &recordingPublisher{err: errors.New("broker down")}
	ref := DueRef{TenantID: a, IntentID: out.Intents[0]}
	var outcomes []string
	for i := 0; i < testPolicy.MaxAttempts; i++ {
		o, _, err := DispatchOne(context.Background(), db, pub, testPolicy, ref)
		if err != nil {
			t.Fatal(err)
		}
		outcomes = append(outcomes, o)
	}
	if outcomes[0] != OutcomeRetry || outcomes[len(outcomes)-1] != OutcomeDead {
		t.Fatalf("%v", outcomes)
	}
	if status, attempts := intentStatus(t, db, a, ref.IntentID); status != "dead" || attempts != testPolicy.MaxAttempts {
		t.Fatalf("%s %d", status, attempts)
	}
	if o, _, _ := DispatchOne(context.Background(), db, pub, testPolicy, ref); o != OutcomeSkipped {
		t.Fatalf("dead intent dispatched again: %s", o)
	}
}

func TestDispatcherRunOnceBoundsConcurrency(t *testing.T) {
	db := dbPool(t)
	a := randomUUID()
	if _, err := RecordEvent(context.Background(), db, alertEvent(t, a), SourceRef{}); err != nil {
		t.Fatal(err)
	}
	pub := &recordingPublisher{}
	d := &Dispatcher{DB: db, Pub: pub, Policy: testPolicy, Workers: 2, Batch: 10000, Interval: time.Millisecond, Metrics: &Metrics{}}
	if _, err := d.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(dueFor(t, db, a)) != 0 || d.Metrics.InFlight.Load() != 0 {
		t.Fatal("due intents left or in-flight leaked")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := d.Run(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestReceiptsAreMonotonic(t *testing.T) {
	db := dbPool(t)
	a := randomUUID()
	out, err := RecordEvent(context.Background(), db, alertEvent(t, a), SourceRef{})
	if err != nil {
		t.Fatal(err)
	}
	id := out.Intents[0]
	// Receipt while still pending: the dispatcher crashed after its confirm.
	if ok, err := ApplyReceipt(context.Background(), db, Receipt{TenantID: a, IntentID: id, Outcome: "sent"}); !ok || err != nil {
		t.Fatalf("%v %v", ok, err)
	}
	if len(dueFor(t, db, a)) != 1 {
		t.Fatal("receipted intent still due for dispatch")
	}
	for _, late := range []string{"sent", "dead", "failed"} {
		if ok, err := ApplyReceipt(context.Background(), db, Receipt{TenantID: a, IntentID: id, Outcome: late}); ok || err != nil {
			t.Fatalf("%s moved a terminal intent: %v", late, err)
		}
	}
	if _, err := ApplyReceipt(context.Background(), db, Receipt{TenantID: a, IntentID: id, Outcome: "exploded"}); !errors.Is(err, ErrUnknownOutcome) {
		t.Fatal(err)
	}
	// Another tenant cannot move tenant a's intent.
	if ok, _ := ApplyReceipt(context.Background(), db, Receipt{TenantID: randomUUID(), IntentID: out.Intents[1], Outcome: "sent"}); ok {
		t.Fatal("cross-tenant receipt applied")
	}
}

type fakeSource struct {
	batches         [][]Record
	committed       []Record
	pollErr         error
	pollWithRecords bool
	commitErr       error
}

func (f *fakeSource) Poll(context.Context) ([]Record, error) {
	if f.pollErr != nil && !f.pollWithRecords {
		return nil, f.pollErr
	}
	if len(f.batches) == 0 {
		return nil, nil
	}
	b := f.batches[0]
	f.batches = f.batches[1:]
	return b, f.pollErr
}

func (f *fakeSource) Commit(_ context.Context, r []Record) error {
	f.committed = append(f.committed, r...)
	return f.commitErr
}

func TestIntakeProcessesRecordsAlongsidePollError(t *testing.T) {
	db := dbPool(t)
	tenant := randomUUID()
	brokerErr, commitErr := errors.New("fetch partition unavailable"), errors.New("commit failed")
	rec := Record{Topic: "alerts", Partition: 0, Offset: time.Now().UnixNano(), Value: alertEventBytes(t, alertEvent(t, tenant))}
	src := &fakeSource{batches: [][]Record{{rec}}, pollErr: brokerErr, pollWithRecords: true, commitErr: commitErr}
	in := &Intake{DB: db, Source: src, Metrics: &Metrics{}, RetryDelay: time.Millisecond}
	err := in.PollOnce(context.Background())
	if !errors.Is(err, brokerErr) || !errors.Is(err, commitErr) {
		t.Fatalf("errors not joined: %v", err)
	}
	if len(src.committed) != 1 || countRows(t, db, tenant, "SELECT count(*) FROM notification_intents") != 2 {
		t.Fatal("record returned alongside poll error was dropped")
	}
}

func TestIntakeCommitsAfterEffectOrQuarantine(t *testing.T) {
	db := dbPool(t)
	a := randomUUID()
	good := alertEventBytes(t, alertEvent(t, a))
	src := &fakeSource{batches: [][]Record{{
		{Topic: "alerts", Partition: 0, Offset: time.Now().UnixNano(), Value: good},
		{Topic: "alerts", Partition: 0, Offset: time.Now().UnixNano() + 1, Value: []byte("not json")},
	}}}
	in := &Intake{DB: db, Source: src, Metrics: &Metrics{}, RetryDelay: time.Millisecond}
	if err := in.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(src.committed) != 2 || in.Metrics.EventsQuarantine.Load() != 1 || in.Metrics.IntentsCreated.Load() != 2 {
		t.Fatalf("committed=%d metrics=%+v", len(src.committed), in.Metrics)
	}
	if err := in.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	src.pollErr = errors.New("broker gone")
	if err := in.PollOnce(context.Background()); err == nil {
		t.Fatal("poll error ignored")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_ = in.Run(ctx)
}

func TestIntakeRetriesTransientErrorsWithoutCommitting(t *testing.T) {
	good := alertEventBytes(t, alertEvent(t, randomUUID()))
	src := &fakeSource{batches: [][]Record{{{Topic: "alerts", Value: good}}}}
	in := &Intake{DB: failingDB{}, Source: src, Metrics: &Metrics{}, RetryDelay: time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := in.PollOnce(ctx); !errors.Is(err, context.DeadlineExceeded) || len(src.committed) != 0 {
		t.Fatalf("err=%v committed=%d", err, len(src.committed))
	}
}

type failingDB struct{}

func (failingDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	return nil, errors.New("database unavailable")
}

func TestReceiptHandler(t *testing.T) {
	db := dbPool(t)
	a := randomUUID()
	out, err := RecordEvent(context.Background(), db, alertEvent(t, a), SourceRef{})
	if err != nil {
		t.Fatal(err)
	}
	m := &Metrics{}
	h := ReceiptHandler(db, m)
	body, _ := json.Marshal(Receipt{TenantID: a, IntentID: out.Intents[0], Outcome: "suppressed"})
	for i := 0; i < 2; i++ {
		if err := h(context.Background(), deliveryOf(body)); err != nil {
			t.Fatal(err)
		}
	}
	if m.ReceiptsApplied.Load() != 1 || m.ReceiptsIgnored.Load() != 1 {
		t.Fatalf("%+v", m)
	}
	for _, bad := range [][]byte{[]byte("{"), []byte(`{"tenant_id":"x","intent_id":"` + out.Intents[0] + `","outcome":"sent"}`), []byte(`{"outcome":"nope"}`)} {
		if err := h(context.Background(), deliveryOf(bad)); !errors.Is(err, rabbit.ErrReject) {
			t.Fatalf("%s: %v", bad, err)
		}
	}
	if err := ReceiptHandler(failingDB{}, m)(context.Background(), deliveryOf(body)); err == nil || errors.Is(err, rabbit.ErrReject) {
		t.Fatalf("transient error must requeue: %v", err)
	}
}

func TestMigrationsApplyTwiceOnAFreshDatabase(t *testing.T) {
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, envOrSkip(t, "POSTGRES_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	name := fmt.Sprintf("jobs_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name+" OWNER jobs_migrator"); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(context.Background(), "DROP DATABASE "+name+" WITH (FORCE)")
	u, _ := url.Parse(envOrSkip(t, "JOBS_MIGRATION_URL"))
	u.Path = "/" + name
	for i := 0; i < 2; i++ {
		if err := migrations.Up(u.String()); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrations.Up("postgres://nobody@127.0.0.1:1/none"); err == nil {
		t.Fatal("unreachable database accepted")
	}
}
