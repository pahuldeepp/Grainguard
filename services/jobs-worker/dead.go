package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"greenguard.local/jobs-worker/rabbit"
)

// deadErrorLimit bounds last_error in the DLQ record; provider/broker errors can be long.
const deadErrorLimit = 200

var errDeadPublishFailed = errors.New("dead-letter publish failed")

// DeadRecord is the metadata-only DLQ message for an intent whose dispatch was exhausted.
// It carries no notification body, address or contact data.
type DeadRecord struct {
	Source             string    `json:"source"`
	IntentID           string    `json:"intent_id"`
	DeliveryGeneration int       `json:"delivery_generation"`
	TenantID           string    `json:"tenant_id"`
	Channel            string    `json:"channel"`
	Attempts           int       `json:"attempts"`
	LastError          string    `json:"last_error"`
	FirstAttemptAt     time.Time `json:"first_attempt_at"`
	LastAttemptAt      time.Time `json:"last_attempt_at"`
	DeadAt             time.Time `json:"dead_at"`
}

// PublishDead copies a committed `dead` transition to the DLQ with a publisher confirm. It is
// best effort: the Postgres row is already dead and stays redrivable, so a failure (often
// the same broker outage that exhausted dispatch) is logged and counted, never retried here.
func PublishDead(ctx context.Context, pub Publisher, timeout time.Duration, m *Metrics, rec DeadRecord) bool {
	rec.Source = rabbit.DeadSourceDispatch
	rec.LastError = truncate(rec.LastError, deadErrorLimit)
	body, err := json.Marshal(rec)
	if err == nil {
		pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
		err = pub.Publish(pctx, rabbit.Message{
			Exchange: rabbit.DeadExchange, Key: rabbit.DeadKey, MessageID: rec.IntentID, Body: body,
			Headers: map[string]any{rabbit.DeadSourceHeader: rabbit.DeadSourceDispatch},
		})
		cancel()
	}
	if err != nil {
		m.DLQPublishFailed.Add(1)
		slog.Warn("dead intent not copied to DLQ; it remains dead in Postgres and redrivable", "intent_id", rec.IntentID, "error", err)
		return false
	}
	m.DLQPublished.Add(1)
	return true
}

type deadOutboxRef struct {
	tenant, intent string
	generation     int
}

// DrainDead lists identifiers through the ID-only selector, then reads, confirms and marks
// each message inside a tenant-scoped row lock. Broker outages leave the row pending.
func (d *Dispatcher) DrainDead(ctx context.Context) error {
	refs, err := selectRefs(ctx, d.DB, `SELECT tenant_id::text, intent_id::text, delivery_generation FROM jobs_dead_letter_refs($1)`, d.Batch,
		func(r pgx.CollectableRow) (deadOutboxRef, error) {
			var ref deadOutboxRef
			return ref, r.Scan(&ref.tenant, &ref.intent, &ref.generation)
		})
	if err != nil {
		return fmt.Errorf("scan dead-letter outbox: %w", err)
	}
	for _, ref := range refs {
		err := WithTenant(ctx, d.DB, ref.tenant, func(ctx context.Context, tx pgx.Tx) error {
			var rec DeadRecord
			err := tx.QueryRow(ctx, `SELECT tenant_id::text, intent_id::text, channel, attempts, last_error,
				first_attempt_at, last_attempt_at, dead_at FROM dead_letter_outbox
				WHERE tenant_id = $1 AND intent_id = $2 AND delivery_generation = $3 AND published_at IS NULL
				FOR UPDATE SKIP LOCKED`, ref.tenant, ref.intent, ref.generation).
				Scan(&rec.TenantID, &rec.IntentID, &rec.Channel, &rec.Attempts, &rec.LastError,
					&rec.FirstAttemptAt, &rec.LastAttemptAt, &rec.DeadAt)
			if err == pgx.ErrNoRows {
				return nil
			}
			if err != nil {
				return err
			}
			rec.DeliveryGeneration = ref.generation
			if !PublishDead(ctx, d.Pub, d.Policy.PublishTimeout, d.Metrics, rec) {
				return errDeadPublishFailed
			}
			_, err = tx.Exec(ctx, `UPDATE dead_letter_outbox SET published_at = now()
				WHERE tenant_id = $1 AND intent_id = $2 AND delivery_generation = $3`, ref.tenant, ref.intent, ref.generation)
			return err
		})
		if err != nil {
			if errors.Is(err, errDeadPublishFailed) {
				return nil
			}
			return err
		}
	}
	return nil
}
