package main

import (
	"bytes"

	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"os/exec"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"greenguard.local/jobs-worker/rabbit"
)

// Live RabbitMQ tests run only through `make rabbitmq-test` (RABBITMQ_LIVE=1).
func liveBroker(t *testing.T) (string, *amqp.Channel) {
	t.Helper()
	if os.Getenv("RABBITMQ_LIVE") != "1" {
		t.Skip("RABBITMQ_LIVE is not 1; run make rabbitmq-test")
	}
	url := envOrSkip(t, "RABBITMQ_URL")
	conn, err := amqp.Dial(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	ch, err := conn.Channel()
	if err != nil {
		t.Fatal(err)
	}
	if err := rabbit.Declare(ch); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{rabbit.TaskQueue, rabbit.RetryQueue, rabbit.DeadQueue} {
		if _, err := ch.QueuePurge(q, false); err != nil {
			t.Fatal(err)
		}
	}
	return url, ch
}

func drain(t *testing.T, ch *amqp.Channel, queue string) map[string]int {
	t.Helper()
	seen := map[string]int{}
	for {
		d, ok, err := ch.Get(queue, true)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			return seen
		}
		seen[d.MessageId]++
	}
}

func TestLiveDispatchSurvivesBrokerRestartWithStableIDs(t *testing.T) {
	url, _ := liveBroker(t)
	restart := envOrSkip(t, "RABBITMQ_RESTART_CMD")
	db := dbPool(t)
	tenant := randomUUID()
	want := map[string]bool{}
	for i := 0; i < 40; i++ {
		out, err := RecordEvent(context.Background(), db, alertEvent(t, tenant), SourceRef{})
		if err != nil {
			t.Fatal(err)
		}
		for _, id := range out.Intents {
			want[id] = true
		}
	}
	pub := rabbit.NewPublisher(url, nil)
	defer pub.Close()
	policy := DispatchPolicy{MaxAttempts: 50, BaseBackoff: 200 * time.Millisecond, MaxBackoff: 2 * time.Second, PublishTimeout: 3 * time.Second}
	d := &Dispatcher{DB: db, Pub: pub, Policy: policy, Workers: 2, Batch: 5, Interval: 50 * time.Millisecond, Metrics: &Metrics{}}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	go func() { _ = d.Run(ctx) }()
	for d.Metrics.Published.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if out, err := exec.Command("sh", "-c", restart).CombinedOutput(); err != nil {
		t.Fatalf("restart broker: %v %s", err, out)
	}
	// Wait for every intent, including ones in retry backoff (not yet due), to be dispatched.
	for countRows(t, db, tenant, "SELECT count(*) FROM notification_intents WHERE status <> 'dispatched'") > 0 && ctx.Err() == nil {
		time.Sleep(200 * time.Millisecond)
	}
	cancel()
	_, ch := liveBrokerNoPurge(t, url)
	// A restarted quorum queue can answer basic.get empty while it recovers; wait for depth.
	for i := 0; i < 100 && countQueue(t, ch, rabbit.TaskQueue) < len(want); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	seen := drain(t, ch, rabbit.TaskQueue)
	assertDispatchedIDs(t, db, tenant, want, seen)
	t.Logf("intents=%d published=%d retried=%d (deduplicated by intent id downstream)", len(want), d.Metrics.Published.Load(), d.Metrics.Retried.Load())
}

func assertDispatchedIDs(t *testing.T, db *pgxpool.Pool, tenant string, want map[string]bool, seen map[string]int) {
	t.Helper()
	missing := 0
	for id := range want {
		if seen[id] == 0 {
			missing++
			t.Errorf("intent %s lost across broker restart", id)
		}
		if status, _ := intentStatus(t, db, tenant, id); status != "dispatched" {
			t.Fatalf("intent %s is %s", id, status)
		}
	}
	t.Logf("missing=%d of %d", missing, len(want))
	// Other tests' leftover pending intents (other tenants) may also be dispatched here;
	// only this tenant's intents are asserted.
	extra := 0
	for id, n := range seen {
		if want[id] {
			extra += n - 1
		}
	}
	t.Logf("duplicate-copies=%d", extra)
}

func liveBrokerNoPurge(t *testing.T, url string) (string, *amqp.Channel) {
	t.Helper()
	var conn *amqp.Connection
	var err error
	for i := 0; i < 60; i++ {
		if conn, err = amqp.Dial(url); err == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	ch, err := conn.Channel()
	if err != nil {
		t.Fatal(err)
	}
	return url, ch
}

func TestLiveDeliveryLimitDeadLettersAndReplayPreservesID(t *testing.T) {
	url, ch := liveBroker(t)
	pub := rabbit.NewPublisher(url, nil)
	defer pub.Close()
	id := randomUUID()
	if err := pub.Publish(context.Background(), rabbit.Message{Key: rabbit.TaskKey, MessageID: id, Body: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	// A consumer that keeps crashing before ack: every delivery is returned to the queue.
	deliveries := nackUntilDead(t, ch)
	if n := countQueue(t, ch, rabbit.DeadQueue); n != 1 {
		t.Fatalf("dlq holds %d after %d deliveries", n, deliveries)
	}
	src, closer, err := rabbit.Dial(url)
	if err != nil {
		t.Fatal(err)
	}
	defer closer()
	n, err := rabbit.ReplayDLQ(context.Background(), pub, src, 10, nil)
	if err != nil || n != 1 {
		t.Fatalf("replayed %d %v", n, err)
	}
	got := awaitReplayedTask(t, ch)
	if got.MessageId != id || got.Headers[rabbit.ReplayedHeader] != int32(1) {
		t.Fatalf("replayed message %q headers %v", got.MessageId, got.Headers)
	}
	t.Logf("deliveries before dead-lettering=%d, replay kept message id %s", deliveries, id)
}

func nackUntilDead(t *testing.T, ch *amqp.Channel) int {
	t.Helper()
	deliveries := 0
	for i := 0; i < 40; i++ {
		d, ok, err := ch.Get(rabbit.TaskQueue, false)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			time.Sleep(100 * time.Millisecond)
			if n := countQueue(t, ch, rabbit.DeadQueue); n == 1 {
				break
			}
			continue
		}
		deliveries++
		_ = d.Nack(false, true)
	}
	return deliveries
}

func awaitReplayedTask(t *testing.T, ch *amqp.Channel) amqp.Delivery {
	t.Helper()
	for i := 0; i < 50; i++ {
		d, ok, err := ch.Get(rabbit.TaskQueue, true)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			return d
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("replayed task did not arrive")
	return amqp.Delivery{}
}

func countQueue(t *testing.T, ch *amqp.Channel, name string) int {
	t.Helper()
	q, err := ch.QueueDeclarePassive(name, true, false, false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	return q.Messages
}

func TestLiveDeadRecordReachesDLQAndReplayRedrivesSameIntent(t *testing.T) {
	url, ch := liveBroker(t)
	db := dbPool(t)
	tenant := randomUUID()
	_, ids := deadIntents(t, db, tenant, &brokerDown{dlqDown: true})
	pub := rabbit.NewPublisher(url, nil)
	defer pub.Close()
	// Copy one committed dead intent to the real DLQ (best-effort path, broker healthy now).
	var rec DeadRecord
	if err := WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT intent_id::text, tenant_id::text, channel, attempts, last_error, first_attempt_at, last_attempt_at, dead_at
			FROM notification_intents WHERE intent_id = $1`, ids[0]).
			Scan(&rec.IntentID, &rec.TenantID, &rec.Channel, &rec.Attempts, &rec.LastError, &rec.FirstAttemptAt, &rec.LastAttemptAt, &rec.DeadAt)
	}); err != nil {
		t.Fatal(err)
	}
	m := &Metrics{}
	if !PublishDead(context.Background(), pub, 3*time.Second, m, rec) || countQueue(t, ch, rabbit.DeadQueue) != 1 {
		t.Fatal("dead record not in DLQ")
	}
	env := map[string]string{"RABBITMQ_URL": url, "JOBS_DATABASE_URL": envOrSkip(t, "JOBS_DIRECT_URL")}
	var out bytes.Buffer
	if err := dlqReplayCommand(context.Background(), nil, func(k string) string { return env[k] }, &out); err != nil {
		t.Fatalf("%v %s", err, out.String())
	}
	if status, attempts := intentStatus(t, db, tenant, ids[0]); status != "pending" || attempts != 0 {
		t.Fatalf("%s %d", status, attempts)
	}
	if n := countQueue(t, ch, rabbit.TaskQueue); n != 0 {
		t.Fatalf("metadata-only record was re-published as a task: %d", n)
	}
	t.Logf("dead intent %s: DLQ record -> dlq-replay -> redriven to pending with the same id (%s)", ids[0], out.String())
}
