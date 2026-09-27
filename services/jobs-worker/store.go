package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// SourceRef identifies the Kafka coordinates of a consumed record, kept for audit in the inbox.
type SourceRef struct {
	Topic     string
	Partition int32
	Offset    int64
}

// Recorded summarises one inbox transaction.
type Recorded struct {
	Duplicate bool
	Intents   []string
}

// RecordEvent writes inbox evidence and notification intents in one tenant transaction.
// Critical notification-producing transitions are owned exclusively by EventBridge/SQS/Lambda.
func RecordEvent(ctx context.Context, db TxStarter, ev AlertEvent, src SourceRef) (Recorded, error) {
	var out Recorded
	version, err := ev.Version()
	if err != nil {
		return out, poison("aggregate_version: %v", err)
	}
	err = WithTenant(ctx, db, ev.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `INSERT INTO inbox (tenant_id, event_id, event_type, source_topic, source_partition, source_offset)
			VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, ev.TenantID, ev.EventID, ev.EventType, src.Topic, src.Partition, src.Offset)
		if err != nil {
			return fmt.Errorf("insert inbox: %w", err)
		}
		if tag.RowsAffected() == 0 {
			out.Duplicate = true
			return nil
		}
		if ev.Payload.Severity == "critical" && len(Channels(ev.EventType, ev.Payload.Severity)) > 0 {
			return nil // Preserve inbox evidence; never dual-route critical alerts through RabbitMQ.
		}
		for _, channel := range Channels(ev.EventType, ev.Payload.Severity) {
			id := IntentID(ev.TenantID, ev.Payload.EpisodeID, version, channel)
			created, err := insertIntent(ctx, tx, ev, version, channel, id)
			if err != nil {
				return err
			}
			if created {
				out.Intents = append(out.Intents, id)
			}
		}
		return nil
	})
	return out, err
}

func insertIntent(ctx context.Context, tx pgx.Tx, ev AlertEvent, version int64, channel, id string) (bool, error) {
	tag, err := tx.Exec(ctx, `INSERT INTO notification_intents (tenant_id, intent_id, source_event_id, alert_id, episode_id,
			transition_version, transition, severity, channel, correlation_id, traceparent)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
		ev.TenantID, id, ev.EventID, ev.Payload.EpisodeID, ev.Payload.EpisodeID, version, ev.EventType, ev.Payload.Severity, channel, ev.CorrelationID, ev.Traceparent)
	if err != nil {
		return false, fmt.Errorf("insert intent: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if _, err := tx.Exec(ctx, `INSERT INTO dispatch_outbox (tenant_id, intent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, ev.TenantID, id); err != nil {
		return false, fmt.Errorf("insert dispatch outbox: %w", err)
	}
	return true, nil
}

// DueRef names one intent whose dispatch is due. It carries identifiers only.
type DueRef struct {
	TenantID  string
	IntentID  string
	Available time.Time
}

// ScanDue lists due outbox identifiers across tenants through the ID-only selector; each
// intent is then read and locked inside its own tenant transaction (DispatchOne).
func ScanDue(ctx context.Context, db TxStarter, limit int) ([]DueRef, error) {
	refs, err := selectRefs(ctx, db, `SELECT tenant_id::text, intent_id::text, available_at FROM jobs_due_dispatch_refs($1)`, limit,
		func(r pgx.CollectableRow) (DueRef, error) {
			var d DueRef
			return d, r.Scan(&d.TenantID, &d.IntentID, &d.Available)
		})
	if err != nil {
		return nil, fmt.Errorf("scan due: %w", err)
	}
	return refs, nil
}

// Receipt is the durable outcome notification-service reports for one intent.
type Receipt struct {
	TenantID           string `json:"tenant_id"`
	IntentID           string `json:"intent_id"`
	Outcome            string `json:"outcome"`
	DeliveryGeneration int    `json:"delivery_generation"`
}

var receiptFrom = map[string][]string{
	"sent":       {"pending", "dispatched", "dead"},
	"failed":     {"pending", "dispatched", "dead"},
	"suppressed": {"pending", "dispatched", "dead"},
	"dead":       {"pending", "dispatched"},
}

// ErrUnknownOutcome rejects receipts with an outcome outside the ledger vocabulary.
var ErrUnknownOutcome = errors.New("unknown receipt outcome")

// ApplyReceipt moves an intent to the reported outcome with a guarded compare-and-set, so
// duplicate or late receipts never change a terminal result. It returns whether it applied.
func ApplyReceipt(ctx context.Context, db TxStarter, r Receipt) (bool, error) {
	from, ok := receiptFrom[r.Outcome]
	if !ok || !uuidPattern.MatchString(r.IntentID) || r.DeliveryGeneration < 0 {
		return false, ErrUnknownOutcome
	}
	applied := false
	err := WithTenant(ctx, db, r.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE notification_intents SET status = $3, updated_at = now()
			WHERE tenant_id = $1 AND intent_id = $2 AND status = ANY($4) AND redrive_count = $5`, r.TenantID, r.IntentID, r.Outcome, from, r.DeliveryGeneration)
		if err != nil {
			return fmt.Errorf("apply receipt: %w", err)
		}
		applied = tag.RowsAffected() == 1
		// A receipt proves the task reached the broker, even if the dispatcher crashed
		// between the confirm and its own commit: stop re-dispatching it.
		if !applied {
			return nil
		}
		_, err = tx.Exec(ctx, `UPDATE dispatch_outbox SET dispatched_at = now() WHERE tenant_id = $1 AND intent_id = $2 AND dispatched_at IS NULL`, r.TenantID, r.IntentID)
		return err
	})
	return applied, err
}
