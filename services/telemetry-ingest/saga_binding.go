package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

var ErrSagaBindingCommandConflict = errors.New("saga binding command identity conflict")

// BindingAwaitCommand is delivered at least once by the saga command topic.
// It is a request to observe this service's own binding, not to create one.
type BindingAwaitCommand struct {
	TenantID     string
	SagaID       string
	CommandID    string
	DeviceID     string
	SagaVersion  int64
	FencingToken int64
	// Traceparent is the saga's sanitized W3C context, or "" (ADR-0004 Saga).
	Traceparent string
}

func RegisterBindingAwait(ctx context.Context, db TxStarter, command BindingAwaitCommand) error {
	if !isUUID(command.TenantID) || !isUUID(command.SagaID) ||
		!isUUID(command.CommandID) || !isUUID(command.DeviceID) ||
		command.SagaVersion < 1 || command.FencingToken < 1 {
		return ErrInvalidEvent
	}
	return WithTenant(ctx, db, command.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		// The inventory event takes the same lock before changing a binding.
		// This closes the race where neither transaction observes the other's row.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
			command.TenantID+":"+command.DeviceID); err != nil {
			return err
		}
		var sagaID, deviceID string
		var version, fence int64
		err := tx.QueryRow(ctx, `INSERT INTO saga_binding_requests
			(tenant_id, command_id, saga_id, device_id, saga_version, fencing_token, traceparent)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,'')) ON CONFLICT (tenant_id,command_id) DO NOTHING
			RETURNING saga_id, device_id, saga_version, fencing_token`,
			command.TenantID, command.CommandID, command.SagaID, command.DeviceID,
			command.SagaVersion, command.FencingToken, command.Traceparent).Scan(&sagaID, &deviceID, &version, &fence)
		if errors.Is(err, pgx.ErrNoRows) {
			err = tx.QueryRow(ctx, `SELECT saga_id, device_id, saga_version, fencing_token
				FROM saga_binding_requests WHERE tenant_id=$1 AND command_id=$2`,
				command.TenantID, command.CommandID).Scan(&sagaID, &deviceID, &version, &fence)
		}
		if err != nil {
			return fmt.Errorf("record binding await: %w", err)
		}
		if sagaID != command.SagaID || deviceID != command.DeviceID ||
			version != command.SagaVersion || fence != command.FencingToken {
			return ErrSagaBindingCommandConflict
		}
		return completeReadyBindingAwaits(ctx, tx, command.TenantID, command.DeviceID)
	})
}

// This runs in the same transaction as an inventory binding event, so a
// successful saga result cannot precede the durable local active binding.
func completeReadyBindingAwaits(ctx context.Context, tx pgx.Tx, tenantID, deviceID string) error {
	_, err := tx.Exec(ctx, `UPDATE saga_binding_requests SET outcome='succeeded', completed_at=clock_timestamp()
		WHERE tenant_id=$1 AND device_id=$2 AND outcome IS NULL
		AND EXISTS (SELECT 1 FROM device_bindings WHERE tenant_id=$1 AND device_id=$2 AND status='active')`,
		tenantID, deviceID)
	return err
}

type BindingResult struct {
	TenantID     string `json:"tenant_id"`
	SagaID       string `json:"saga_id"`
	CommandID    string `json:"command_id"`
	ResultID     string `json:"result_id"`
	Step         string `json:"step"`
	SagaVersion  int64  `json:"saga_version"`
	FencingToken int64  `json:"fencing_token"`
	Outcome      string `json:"outcome"`
	// Traceparent echoes the command's context; the saga decoder ignores it.
	Traceparent string `json:"traceparent,omitempty"`
}

// PublishNextBindingResult marks a result sent only after the broker confirms
// it. A crash before the SQL commit can duplicate the same result_id; the saga
// inbox handles that redelivery.
func PublishNextBindingResult(ctx context.Context, db TxStarter, tenantID string,
	publish func(context.Context, []byte, []byte) error) (bool, error) {
	if !isUUID(tenantID) || publish == nil {
		return false, ErrInvalidTenant
	}
	sent := false
	err := WithTenant(ctx, db, tenantID, func(ctx context.Context, tx pgx.Tx) error {
		result := BindingResult{TenantID: tenantID, Step: "binding.await", Outcome: "succeeded"}
		err := tx.QueryRow(ctx, `SELECT saga_id, command_id, result_id, saga_version, fencing_token,
			COALESCE(traceparent, '') FROM saga_binding_requests WHERE tenant_id=$1 AND outcome='succeeded' AND published_at IS NULL
			ORDER BY completed_at, command_id FOR UPDATE SKIP LOCKED LIMIT 1`, tenantID).Scan(
			&result.SagaID, &result.CommandID, &result.ResultID, &result.SagaVersion, &result.FencingToken,
			&result.Traceparent)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		value, err := json.Marshal(result)
		if err != nil {
			return err
		}
		if err := publish(ctx, []byte(tenantID+":"+result.SagaID), value); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE saga_binding_requests SET published_at=clock_timestamp()
			WHERE tenant_id=$1 AND command_id=$2`, tenantID, result.CommandID)
		sent = err == nil
		return err
	})
	return sent && err == nil, err
}
