package saga

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
)

type AuditEntry struct {
	Version    int64     `json:"version"`
	Action     string    `json:"action"`
	ActorSub   *string   `json:"actor_sub,omitempty"`
	Reason     *string   `json:"reason,omitempty"`
	RecordedAt time.Time `json:"recorded_at"`
}

func (s Store) Status(ctx context.Context, tenantID, sagaID string) (Snapshot, []AuditEntry, error) {
	if !common.TenantPattern.MatchString(tenantID) || !common.TenantPattern.MatchString(sagaID) {
		return Snapshot{}, nil, ErrInvalidRequest
	}
	var snap Snapshot
	var audit []AuditEntry
	err := common.WithTenantSchema(ctx, s.DB, tenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		snap = Snapshot{TenantID: tenantID, SagaID: sagaID}
		err := tx.QueryRow(ctx, `SELECT device_id, asset_id, state, version, fencing_token, deadline_at
			FROM provisioning_sagas WHERE tenant_id=$1 AND saga_id=$2`, tenantID, sagaID).Scan(
			&snap.DeviceID, &snap.AssetID, &snap.State, &snap.Version, &snap.FencingToken, &snap.DeadlineAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSagaNotFound
		}
		if err != nil {
			return fmt.Errorf("read saga status: %w", err)
		}
		rows, err := tx.Query(ctx, `SELECT version, action, actor_sub, reason, recorded_at FROM saga_audit
			WHERE tenant_id=$1 AND saga_id=$2 ORDER BY recorded_at, audit_id LIMIT 1000`, tenantID, sagaID)
		if err != nil {
			return fmt.Errorf("read saga audit: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var entry AuditEntry
			if err := rows.Scan(&entry.Version, &entry.Action, &entry.ActorSub, &entry.Reason, &entry.RecordedAt); err != nil {
				return err
			}
			audit = append(audit, entry)
		}
		return rows.Err()
	})
	if err != nil {
		return Snapshot{}, nil, err
	}
	return snap, audit, nil
}
