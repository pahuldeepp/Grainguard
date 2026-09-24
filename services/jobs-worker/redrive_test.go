package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"
	"greenguard.local/jobs-worker/rabbit"
)

// brokerDown fails task publishes (the outage that exhausts dispatch); DLQ publishes
// succeed unless dlqDown is set.
type brokerDown struct {
	mu      sync.Mutex
	dlqDown bool
	dead    []rabbit.Message
}

func (b *brokerDown) Publish(_ context.Context, m rabbit.Message) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if m.Exchange != rabbit.DeadExchange || b.dlqDown {
		return errors.New(strings.Repeat("connection refused ", 40))
	}
	b.dead = append(b.dead, m)
	return nil
}

var oneShot = DispatchPolicy{MaxAttempts: 1, BaseBackoff: time.Millisecond, MaxBackoff: time.Millisecond, PublishTimeout: time.Second}

// deadIntents records a critical alert for tenant and exhausts dispatch of its 3 intents.
func deadIntents(t *testing.T, db TxStarter, tenant string, pub Publisher) (*Dispatcher, []string) {
	t.Helper()
	out, err := RecordEvent(context.Background(), db, alertEvent(t, tenant), SourceRef{})
	if err != nil {
		t.Fatal(err)
	}
	d := &Dispatcher{DB: db, Pub: pub, Policy: oneShot, Workers: 2, Metrics: &Metrics{}}
	for _, id := range out.Intents {
		_, dead, err := DispatchOne(context.Background(), db, pub, oneShot, DueRef{TenantID: tenant, IntentID: id})
		if err != nil || dead == nil {
			t.Fatalf("dead=%v err=%v", dead, err)
		}
		PublishDead(context.Background(), pub, time.Second, d.Metrics, *dead)
	}
	return d, out.Intents
}

func TestDeadTransitionCopiesMetadataOnlyRecordToDLQ(t *testing.T) {
	db := dbPool(t)
	tenant := randomUUID()
	pub := &brokerDown{}
	d, ids := deadIntents(t, db, tenant, pub)
	if len(pub.dead) != 3 || d.Metrics.DLQPublished.Load() != 3 {
		t.Fatalf("dlq records %d", len(pub.dead))
	}
	m := pub.dead[0]
	if m.Key != rabbit.DeadKey || m.MessageID != ids[0] || m.Headers[rabbit.DeadSourceHeader] != rabbit.DeadSourceDispatch {
		t.Fatalf("%+v", m)
	}
	var fields map[string]any
	if err := json.Unmarshal(m.Body, &fields); err != nil {
		t.Fatal(err)
	}
	want := []string{"source", "intent_id", "tenant_id", "delivery_generation", "channel", "attempts", "last_error", "first_attempt_at", "last_attempt_at", "dead_at"}
	if len(fields) != len(want) {
		t.Fatalf("unexpected DLQ fields %v", fields)
	}
	for _, k := range want {
		if fields[k] == nil || fields[k] == "" {
			t.Fatalf("missing %s in %v", k, fields)
		}
	}
	if len(fields["last_error"].(string)) > deadErrorLimit || fields["attempts"].(float64) != 1 {
		t.Fatalf("%v", fields)
	}
	if status, _ := intentStatus(t, db, tenant, ids[0]); status != "dead" {
		t.Fatal(status)
	}
}

func TestFailedDLQPublishKeepsDeadAndRedriveRestoresSameIntent(t *testing.T) {
	db := dbPool(t)
	tenant := randomUUID()
	pub := &brokerDown{dlqDown: true}
	d, ids := deadIntents(t, db, tenant, pub)
	if d.Metrics.DLQPublishFailed.Load() != 3 || len(pub.dead) != 0 {
		t.Fatalf("failed=%d", d.Metrics.DLQPublishFailed.Load())
	}
	if status, _ := intentStatus(t, db, tenant, ids[0]); status != "dead" {
		t.Fatalf("dead transition undone: %s", status)
	}
	done, err := RedriveDead(context.Background(), db, RedriveOptions{Limit: 10, TenantID: tenant, Actor: "ops@example", Reason: "broker restored"})
	if err != nil || len(done) != 3 {
		t.Fatalf("%v %v", done, err)
	}
	status, attempts := intentStatus(t, db, tenant, ids[0])
	if status != "pending" || attempts != 0 {
		t.Fatalf("%s %d", status, attempts)
	}
	assertRedriveAudit(t, db, tenant, ids[0])
	good := &recordingPublisher{}
	for _, ref := range dueFor(t, db, tenant) {
		if o, _, err := DispatchOne(context.Background(), db, good, testPolicy, ref); err != nil || o != OutcomePublished {
			t.Fatalf("%s %v", o, err)
		}
	}
	if len(good.ids) != 3 || !contains(good.ids, ids[0]) {
		t.Fatalf("redrive changed identity: %v vs %v", good.ids, ids)
	}
	if n := countRows(t, db, tenant, "SELECT count(*) FROM notification_intents"); n != 3 {
		t.Fatalf("redrive created intents: %d", n)
	}
}

func TestDeadOutboxRetriesAfterBrokerRecovery(t *testing.T) {
	db := dbPool(t)
	tenant := randomUUID()
	down := &brokerDown{dlqDown: true}
	d, ids := deadIntents(t, db, tenant, down)
	d.Batch = 20
	if err := d.DrainDead(context.Background()); err != nil {
		t.Fatal(err)
	}
	if d.Metrics.DLQPublishFailed.Load() != int64(len(ids)+1) {
		t.Fatal("drain should stop after its first failed publish")
	}
	var pending int
	if err := WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM dead_letter_outbox WHERE published_at IS NULL`).Scan(&pending)
	}); err != nil || pending != len(ids) {
		t.Fatalf("pending=%d err=%v", pending, err)
	}
	up := &brokerDown{}
	d.Pub = up
	if err := d.DrainDead(context.Background()); err != nil {
		t.Fatal(err)
	}
	owned := 0
	for _, msg := range up.dead {
		var rec DeadRecord
		if err := json.Unmarshal(msg.Body, &rec); err != nil {
			t.Fatal(err)
		}
		if rec.TenantID == tenant {
			owned++
		}
	}
	if owned != len(ids) {
		t.Fatalf("published own=%d", owned)
	}
	if err := WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM dead_letter_outbox WHERE published_at IS NULL`).Scan(&pending)
	}); err != nil || pending != 0 {
		t.Fatalf("pending=%d err=%v", pending, err)
	}
	before := len(up.dead)
	if err := d.DrainDead(context.Background()); err != nil || len(up.dead) != before {
		t.Fatalf("duplicate dead publish: %d %v", len(up.dead), err)
	}
}

func TestStaleReceiptCannotCompleteRedrivenAttempt(t *testing.T) {
	db := dbPool(t)
	tenant := randomUUID()
	_, ids := deadIntents(t, db, tenant, &brokerDown{dlqDown: true})
	if ok, err := RedriveOne(context.Background(), db, DeadRef{TenantID: tenant, IntentID: ids[0]}, "test", "retry"); !ok || err != nil {
		t.Fatalf("redrive: %v %v", ok, err)
	}
	stale := Receipt{TenantID: tenant, IntentID: ids[0], Outcome: "sent", DeliveryGeneration: 0}
	if ok, err := ApplyReceipt(context.Background(), db, stale); ok || err != nil {
		t.Fatalf("stale receipt applied: %v %v", ok, err)
	}
	if status, _ := intentStatus(t, db, tenant, ids[0]); status != "pending" {
		t.Fatal(status)
	}
	if len(dueFor(t, db, tenant)) != 1 {
		t.Fatal("stale receipt marked redrive outbox sent")
	}
	stale.DeliveryGeneration = 1
	if ok, err := ApplyReceipt(context.Background(), db, stale); !ok || err != nil {
		t.Fatalf("current receipt rejected: %v %v", ok, err)
	}
}

func assertRedriveAudit(t *testing.T, db *pgxpool.Pool, tenant, id string) {
	t.Helper()
	var actor string
	var previous int
	if err := WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT actor, previous_attempts FROM intent_redrives WHERE intent_id = $1 AND redrive_no = 1", id).Scan(&actor, &previous)
	}); err != nil || actor != "ops@example" || previous != 1 {
		t.Fatalf("audit %q %d %v", actor, previous, err)
	}
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func TestDLQReplayAfterRedriveIsANoOp(t *testing.T) {
	db := dbPool(t)
	tenant := randomUUID()
	pub := &brokerDown{}
	_, ids := deadIntents(t, db, tenant, pub)
	if _, err := RedriveDead(context.Background(), db, RedriveOptions{Limit: 10, TenantID: tenant, Actor: "ops", Reason: "fixed"}); err != nil {
		t.Fatal(err)
	}
	handler := dlqRedrive(db)
	d := amqp.Delivery{MessageId: pub.dead[0].MessageID, Body: pub.dead[0].Body}
	if err := handler(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	var redrives int
	_ = WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT count(*) FROM intent_redrives WHERE intent_id = $1", ids[0]).Scan(&redrives)
	})
	if redrives != 1 || countRows(t, db, tenant, "SELECT count(*) FROM notification_intents") != 3 {
		t.Fatalf("replay of a redriven intent redrove it again: %d", redrives)
	}
	if err := handler(context.Background(), amqp.Delivery{MessageId: "other", Body: pub.dead[0].Body}); err == nil {
		t.Fatal("mismatched message id accepted")
	}
	if err := handler(context.Background(), amqp.Delivery{Body: []byte("{")}); err == nil {
		t.Fatal("broken record accepted")
	}
}

func TestRedriveTenantFilterIsIsolatedByRLS(t *testing.T) {
	db := dbPool(t)
	a, b := randomUUID(), randomUUID()
	_, idsA := deadIntents(t, db, a, &brokerDown{})
	_, idsB := deadIntents(t, db, b, &brokerDown{})
	done, err := RedriveDead(context.Background(), db, RedriveOptions{Limit: 100, TenantID: a, Actor: "ops", Reason: "tenant a only"})
	if err != nil || len(done) != 3 {
		t.Fatalf("%v %v", done, err)
	}
	for _, ref := range done {
		if ref.TenantID != a {
			t.Fatalf("filter leaked %v", ref)
		}
	}
	if status, _ := intentStatus(t, db, b, idsB[0]); status != "dead" {
		t.Fatalf("tenant b touched: %s", status)
	}
	// Naming tenant a with tenant b's intent id finds nothing under tenant a's RLS.
	if ok, err := RedriveOne(context.Background(), db, DeadRef{TenantID: a, IntentID: idsB[1]}, "ops", "x"); ok || err != nil {
		t.Fatalf("cross-tenant redrive %v %v", ok, err)
	}
	if ok, _ := RedriveOne(context.Background(), db, DeadRef{TenantID: a, IntentID: idsA[0]}, "ops", "x"); ok {
		t.Fatal("a pending intent was redriven")
	}
	if _, err := RedriveDead(context.Background(), db, RedriveOptions{Limit: 1, Actor: "ops"}); !errors.Is(err, ErrRedriveOptions) {
		t.Fatal("missing reason accepted")
	}
	// Unfiltered operator scan (redrive-scan policy) works across tenants, bounded by limit.
	if all, err := RedriveDead(context.Background(), db, RedriveOptions{Limit: 1, Actor: "ops", Reason: "sweep"}); err != nil || len(all) != 1 {
		t.Fatalf("%v %v", all, err)
	}
}

func TestOperatorCommands(t *testing.T) {
	db := dbPool(t)
	_ = db
	tenant := randomUUID()
	deadIntents(t, db, tenant, &brokerDown{})
	env := map[string]string{"JOBS_DATABASE_URL": envOrSkip(t, "JOBS_DIRECT_URL"), "USER": "tester"}
	getenv := func(k string) string { return env[k] }
	var out bytes.Buffer
	if err := redriveCommand(context.Background(), []string{"-tenant", tenant, "-reason", "test"}, getenv, &out); err != nil || !strings.Contains(out.String(), "redriven 3 dead intents") {
		t.Fatalf("%v %s", err, out.String())
	}
	if err := redriveCommand(context.Background(), []string{"-tenant", tenant}, getenv, &out); !errors.Is(err, ErrRedriveOptions) {
		t.Fatalf("missing reason: %v", err)
	}
	if err := redriveCommand(context.Background(), []string{"-bogus"}, getenv, &out); err == nil {
		t.Fatal("bad flag accepted")
	}
	if err := redriveCommand(context.Background(), nil, func(string) string { return "" }, &out); err == nil {
		t.Fatal("missing database accepted")
	}
	if err := dlqReplayCommand(context.Background(), nil, func(string) string { return "" }, &out); err == nil {
		t.Fatal("missing broker accepted")
	}
	if err := dlqReplayCommand(context.Background(), []string{"-bogus"}, getenv, &out); err == nil {
		t.Fatal("bad flag accepted")
	}
	dialBroker = func(string) (rabbit.Channel, func() error, error) { return nil, nil, errors.New("refused") }
	defer func() { dialBroker = rabbit.Dial }()
	env["RABBITMQ_URL"] = "amqp://x"
	if err := dlqReplayCommand(context.Background(), nil, getenv, &out); err == nil {
		t.Fatal("dial error ignored")
	}
	if err := dispatch(context.Background(), []string{"redrive-dead", "-limit", "0", "-reason", "x"}, getenv, &out); err == nil {
		t.Fatal("zero limit accepted")
	}
	if err := dispatch(context.Background(), []string{"dlq-replay"}, func(string) string { return "" }, &out); err == nil {
		t.Fatal("dlq-replay without config accepted")
	}
}
