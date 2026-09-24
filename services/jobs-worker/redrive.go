package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// RedriveOptions bound one operator redrive run.
type RedriveOptions struct {
	Limit    int
	TenantID string // optional; when set every read and write runs under that tenant's RLS
	Actor    string
	Reason   string
}

var ErrRedriveOptions = errors.New("redrive needs a positive limit, an actor and a reason")

// DeadRef names one dead intent.
type DeadRef struct{ TenantID, IntentID string }

// RedriveDead moves up to Limit dead intents back to pending through the audited transition.
func RedriveDead(ctx context.Context, db TxStarter, opts RedriveOptions) ([]DeadRef, error) {
	if opts.Limit < 1 || opts.Actor == "" || opts.Reason == "" {
		return nil, ErrRedriveOptions
	}
	refs, err := listDead(ctx, db, opts)
	if err != nil {
		return nil, err
	}
	var done []DeadRef
	for _, ref := range refs {
		ok, err := RedriveOne(ctx, db, ref, opts.Actor, opts.Reason)
		if err != nil {
			return done, err
		}
		if ok {
			done = append(done, ref)
		}
	}
	return done, nil
}

func listDead(ctx context.Context, db TxStarter, opts RedriveOptions) ([]DeadRef, error) {
	var refs []DeadRef
	query := func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT tenant_id::text, intent_id::text FROM notification_intents
			WHERE status = 'dead' ORDER BY dead_at NULLS FIRST, intent_id LIMIT $1`, opts.Limit)
		if err != nil {
			return fmt.Errorf("list dead intents: %w", err)
		}
		refs, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (DeadRef, error) {
			var d DeadRef
			return d, r.Scan(&d.TenantID, &d.IntentID)
		})
		return err
	}
	if opts.TenantID != "" {
		return refs, WithTenant(ctx, db, opts.TenantID, query)
	}
	return refs, inTx(ctx, db, "app.scope", "redrive-scan", query)
}

// RedriveOne is the only dead -> pending transition. In one tenant transaction it records
// who/when/why and the previous attempt state, resets the attempt counters, keeps the SAME
// intent_id and re-arms the dispatch outbox. It returns false if the intent is not dead.
func RedriveOne(ctx context.Context, db TxStarter, ref DeadRef, actor, reason string) (bool, error) {
	return redriveOne(ctx, db, ref, actor, reason, nil)
}

func redriveOne(ctx context.Context, db TxStarter, ref DeadRef, actor, reason string, expectedGeneration *int) (bool, error) {
	redriven := false
	err := WithTenant(ctx, db, ref.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `INSERT INTO intent_redrives (tenant_id, intent_id, redrive_no, actor, reason, previous_attempts, previous_last_error, previous_dead_at)
			SELECT tenant_id, intent_id, redrive_count + 1, $3, $4, attempts, last_error, dead_at
			  FROM notification_intents WHERE tenant_id = $1 AND intent_id = $2 AND status = 'dead'
			  AND ($5::integer IS NULL OR redrive_count = $5)
			FOR UPDATE`, ref.TenantID, ref.IntentID, truncate(actor, 200), truncate(reason, 500), expectedGeneration)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE notification_intents SET status = 'pending', attempts = 0, next_attempt_at = now(),
				last_error = NULL, dead_at = NULL, redrive_count = redrive_count + 1, updated_at = now()
			WHERE tenant_id = $1 AND intent_id = $2 AND status = 'dead'`, ref.TenantID, ref.IntentID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE dispatch_outbox SET dispatched_at = NULL, available_at = now() WHERE tenant_id = $1 AND intent_id = $2`, ref.TenantID, ref.IntentID)
		redriven = err == nil
		return err
	})
	return redriven, err
}
