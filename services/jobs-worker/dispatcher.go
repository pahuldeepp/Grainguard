package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"greenguard.local/jobs-worker/rabbit"
)

// Task is the RabbitMQ delivery task body. It carries identifiers and routing facts only;
// notification-service renders content and applies tenant preferences.
type Task struct {
	IntentID           string `json:"intent_id"`
	TenantID           string `json:"tenant_id"`
	Channel            string `json:"channel"`
	Transition         string `json:"transition"`
	Severity           string `json:"severity"`
	AlertID            string `json:"alert_id"`
	EpisodeID          string `json:"episode_id"`
	TransitionVersion  int64  `json:"transition_version"`
	DeliveryGeneration int    `json:"delivery_generation"`
	CorrelationID      string `json:"correlation_id"`
	Traceparent        string `json:"traceparent"`
}

// Publisher returns nil only after a broker confirm.
type Publisher interface {
	Publish(ctx context.Context, m rabbit.Message) error
}

// DispatchPolicy bounds dispatch: attempts, backoff and publish timeout.
type DispatchPolicy struct {
	MaxAttempts    int
	BaseBackoff    time.Duration
	MaxBackoff     time.Duration
	PublishTimeout time.Duration
}

// Backoff is exponential without jitter (deterministic for tests): base * 2^(attempt-1), capped.
func (p DispatchPolicy) Backoff(attempt int) time.Duration {
	d := p.BaseBackoff
	for i := 1; i < attempt && d < p.MaxBackoff; i++ {
		d *= 2
	}
	return min(d, p.MaxBackoff)
}

// Dispatch outcomes.
const (
	OutcomeSkipped   = "skipped"
	OutcomePublished = "published"
	OutcomeRetry     = "retry"
	OutcomeDead      = "dead"
)

// DispatchOne locks one due intent (FOR UPDATE SKIP LOCKED), publishes it with a confirm and
// marks it dispatched in the same transaction. If the process dies after the confirm and
// before the commit, the row stays pending and is re-published with the SAME message ID.
func DispatchOne(ctx context.Context, db TxStarter, pub Publisher, policy DispatchPolicy, ref DueRef) (string, *DeadRecord, error) {
	outcome := OutcomeSkipped
	var dead *DeadRecord
	err := WithTenant(ctx, db, ref.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		task, attempts, found, err := lockPending(ctx, tx, ref)
		if err != nil || !found {
			return err
		}
		body, err := json.Marshal(task)
		if err != nil {
			return err
		}
		pctx, cancel := context.WithTimeout(ctx, policy.PublishTimeout)
		pubErr := pub.Publish(pctx, rabbit.Message{Key: rabbit.TaskKey, MessageID: task.IntentID, Body: body})
		cancel()
		outcome, dead, err = recordDispatch(ctx, tx, policy, ref, attempts+1, pubErr)
		return err
	})
	if err != nil {
		return outcome, nil, err
	}
	return outcome, dead, nil
}

func lockPending(ctx context.Context, tx pgx.Tx, ref DueRef) (Task, int, bool, error) {
	t := Task{TenantID: ref.TenantID}
	var attempts int
	err := tx.QueryRow(ctx, `SELECT intent_id::text, channel, transition, severity, alert_id::text, episode_id::text,
			transition_version, correlation_id::text, traceparent, attempts, redrive_count
		FROM notification_intents WHERE tenant_id = $1 AND intent_id = $2 AND status = 'pending'
		FOR UPDATE SKIP LOCKED`, ref.TenantID, ref.IntentID).
		Scan(&t.IntentID, &t.Channel, &t.Transition, &t.Severity, &t.AlertID, &t.EpisodeID, &t.TransitionVersion, &t.CorrelationID, &t.Traceparent, &attempts, &t.DeliveryGeneration)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, 0, false, nil
	}
	if err != nil {
		return t, 0, false, fmt.Errorf("lock intent: %w", err)
	}
	return t, attempts, true, nil
}

// attemptColumns stamps first/last attempt times on every dispatch attempt.
const attemptColumns = `attempts = $3, first_attempt_at = coalesce(first_attempt_at, now()), last_attempt_at = now(), updated_at = now()`

func recordDispatch(ctx context.Context, tx pgx.Tx, policy DispatchPolicy, ref DueRef, attempts int, pubErr error) (string, *DeadRecord, error) {
	const markOutbox = `UPDATE dispatch_outbox SET dispatched_at = now() WHERE tenant_id = $1 AND intent_id = $2`
	if pubErr == nil {
		if _, err := tx.Exec(ctx, `UPDATE notification_intents SET status = 'dispatched', dispatched_at = now(), last_error = NULL, `+attemptColumns+`
			WHERE tenant_id = $1 AND intent_id = $2`, ref.TenantID, ref.IntentID, attempts); err != nil {
			return "", nil, err
		}
		_, err := tx.Exec(ctx, markOutbox, ref.TenantID, ref.IntentID)
		return OutcomePublished, nil, err
	}
	reason := truncate(pubErr.Error(), 500)
	if attempts >= policy.MaxAttempts {
		dead := &DeadRecord{TenantID: ref.TenantID, IntentID: ref.IntentID}
		var generation int
		if err := tx.QueryRow(ctx, `UPDATE notification_intents SET status = 'dead', last_error = $4, dead_at = now(), `+attemptColumns+`
			WHERE tenant_id = $1 AND intent_id = $2
			RETURNING channel, attempts, last_error, first_attempt_at, last_attempt_at, dead_at, redrive_count`, ref.TenantID, ref.IntentID, attempts, reason).
			Scan(&dead.Channel, &dead.Attempts, &dead.LastError, &dead.FirstAttemptAt, &dead.LastAttemptAt, &dead.DeadAt, &generation); err != nil {
			return "", nil, err
		}
		dead.DeliveryGeneration = generation
		if _, err := tx.Exec(ctx, `INSERT INTO dead_letter_outbox (tenant_id, intent_id, delivery_generation, channel, attempts, last_error, first_attempt_at, last_attempt_at, dead_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, ref.TenantID, ref.IntentID, generation, dead.Channel, dead.Attempts, dead.LastError, dead.FirstAttemptAt, dead.LastAttemptAt, dead.DeadAt); err != nil {
			return "", nil, err
		}
		_, err := tx.Exec(ctx, markOutbox, ref.TenantID, ref.IntentID)
		return OutcomeDead, dead, err
	}
	next := time.Now().Add(policy.Backoff(attempts))
	if _, err := tx.Exec(ctx, `UPDATE notification_intents SET next_attempt_at = $4, last_error = $5, `+attemptColumns+`
		WHERE tenant_id = $1 AND intent_id = $2`, ref.TenantID, ref.IntentID, attempts, next, reason); err != nil {
		return "", nil, err
	}
	_, err := tx.Exec(ctx, `UPDATE dispatch_outbox SET available_at = $3 WHERE tenant_id = $1 AND intent_id = $2`, ref.TenantID, ref.IntentID, next)
	return OutcomeRetry, nil, err
}

func truncate(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.ValidString(s[:n]) {
		n--
	}
	return s[:n]
}

// Dispatcher runs the dispatch pool: one scanner feeding at most Workers concurrent
// DispatchOne calls. It is separate from the Kafka intake and the receipt consumer.
type Dispatcher struct {
	DB       TxStarter
	Pub      Publisher
	Policy   DispatchPolicy
	Workers  int
	Batch    int
	Interval time.Duration
	Metrics  *Metrics
}

// RunOnce scans one batch and dispatches it with bounded concurrency.
func (d *Dispatcher) RunOnce(ctx context.Context) (int, error) {
	refs, err := ScanDue(ctx, d.DB, d.Batch)
	if err != nil {
		return 0, err
	}
	d.Metrics.observeLag(refs)
	sem := make(chan struct{}, max(1, d.Workers))
	var wg sync.WaitGroup
	var progressed atomic.Int64
	for _, ref := range refs {
		sem <- struct{}{}
		wg.Add(1)
		go func(ref DueRef) {
			defer func() { <-sem; wg.Done() }()
			d.Metrics.InFlight.Add(1)
			defer d.Metrics.InFlight.Add(-1)
			outcome, dead, err := DispatchOne(ctx, d.DB, d.Pub, d.Policy, ref)
			if err != nil {
				slog.Error("dispatch failed", "intent_id", ref.IntentID, "error", err)
				return
			}
			d.Metrics.countDispatch(outcome)
			if outcome != OutcomeSkipped {
				progressed.Add(1)
			}
			_ = dead // The committed dead-letter outbox is drained below.
		}(ref)
	}
	wg.Wait()
	if err := d.DrainDead(ctx); err != nil {
		return int(progressed.Load()), err
	}
	return int(progressed.Load()), nil
}

// Run loops until ctx ends; an empty or failed scan waits Interval.
func (d *Dispatcher) Run(ctx context.Context) error {
	for {
		n, err := d.RunOnce(ctx)
		if err != nil {
			slog.Error("dispatch scan failed", "error", err)
		}
		if n > 0 && err == nil {
			continue
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(d.Interval):
		}
	}
}
