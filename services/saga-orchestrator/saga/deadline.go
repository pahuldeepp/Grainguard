package saga

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
)

// timeoutCompensation names the first undo command for a forward state whose
// participant did not answer in time. Commands share the tenant:saga Kafka key,
// so the cancellation is delivered after the unanswered command it undoes; each
// participant treats an undo of a change it never made as a successful no-op.
var timeoutCompensation = map[string]string{
	"reserving":   "asset.release",
	"configuring": "asset.release",
	"activating":  "inventory.deactivate",
}

type dueSaga struct {
	id, state, deviceID, assetID string
	version, fence               int64
}

// ExpireDue handles at most limit timed-out sagas for one tenant. A forward
// step is compensated: the cancellation command and state change commit before
// any publication. A timed-out compensation is quarantined as repair_required
// for an audited operator decision; its late result is still accepted.
func (s Store) ExpireDue(ctx context.Context, tenantID string, limit int) (int, error) {
	if !common.TenantPattern.MatchString(tenantID) || limit < 1 || limit > 100 {
		return 0, ErrInvalidRequest
	}
	count := 0
	err := common.WithTenantSchema(ctx, s.DB, tenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		if err := s.fence(ctx, tx, tenantID); err != nil {
			return err
		}
		due, err := lockDue(ctx, tx, tenantID, limit)
		if err != nil {
			return err
		}
		for _, item := range due {
			if err := expireOne(ctx, tx, tenantID, item); err != nil {
				return err
			}
			count++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return count, nil
}

func lockDue(ctx context.Context, tx pgx.Tx, tenantID string, limit int) ([]dueSaga, error) {
	rows, err := tx.Query(ctx, `SELECT saga_id, state, device_id, asset_id, version, fencing_token
		FROM provisioning_sagas WHERE tenant_id=$1
		AND deadline_at <= now() AND state NOT IN ('active','compensated','repair_required')
		ORDER BY deadline_at, saga_id LIMIT $2 FOR UPDATE SKIP LOCKED`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var due []dueSaga
	for rows.Next() {
		var d dueSaga
		if err := rows.Scan(&d.id, &d.state, &d.deviceID, &d.assetID, &d.version, &d.fence); err != nil {
			return nil, err
		}
		due = append(due, d)
	}
	return due, rows.Err()
}

func expireOne(ctx context.Context, tx pgx.Tx, tenantID string, d dueSaga) error {
	step, compensate := timeoutCompensation[d.state]
	if !compensate {
		_, err := tx.Exec(ctx, `UPDATE provisioning_sagas SET state='repair_required', updated_at=now()
			WHERE tenant_id=$1 AND saga_id=$2`, tenantID, d.id)
		if err != nil {
			return err
		}
		return audit(ctx, tx, tenantID, d.id, d.version, "deadline.expired", "compensation result unconfirmed")
	}
	var version int64
	err := tx.QueryRow(ctx, `UPDATE provisioning_sagas SET state='compensating', version=version+1,
		deadline_at=now() + interval '15 minutes', updated_at=now()
		WHERE tenant_id=$1 AND saga_id=$2 RETURNING version`, tenantID, d.id).Scan(&version)
	if err != nil {
		return err
	}
	snap := Snapshot{TenantID: tenantID, SagaID: d.id, DeviceID: d.deviceID, AssetID: d.assetID,
		Version: version, FencingToken: d.fence}
	if err := queueCommand(ctx, tx, snap, step); err != nil {
		return err
	}
	return audit(ctx, tx, tenantID, d.id, version, "deadline.compensate", d.state+" result not received before deadline")
}

func audit(ctx context.Context, tx pgx.Tx, tenantID, sagaID string, version int64, action, reason string) error {
	_, err := tx.Exec(ctx, `INSERT INTO saga_audit (tenant_id,saga_id,version,action,reason)
		VALUES ($1,$2,$3,$4,NULLIF($5,''))`, tenantID, sagaID, version, action, reason)
	if err != nil {
		return fmt.Errorf("audit %s: %w", action, err)
	}
	return nil
}

// queueCommand writes one participant command with the saga's current version
// and fencing token in the caller's transaction, under the saga's one trace
// context. The caller holds the saga row lock.
func queueCommand(ctx context.Context, tx pgx.Tx, snap Snapshot, step string) error {
	trace, err := ensureSagaTrace(ctx, tx, snap.TenantID, snap.SagaID, snap.Version)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO saga_command_outbox
		(tenant_id, saga_id, step, saga_version, fencing_token, payload, traceparent)
		VALUES ($1, $2, $3, $4, $5,
		jsonb_build_object('tenant_id', ($1::uuid)::text, 'saga_id', ($2::uuid)::text,
		'device_id', ($6::uuid)::text, 'asset_id', ($7::uuid)::text), $8)`,
		snap.TenantID, snap.SagaID, step, snap.Version, snap.FencingToken, snap.DeviceID, snap.AssetID, trace)
	if err != nil {
		return fmt.Errorf("queue %s command: %w", step, err)
	}
	return nil
}
