package saga

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
)

var (
	ErrSagaNotFound   = errors.New("saga not found")
	ErrResultConflict = errors.New("result conflicts with an existing result")
	ErrStaleResult    = errors.New("stale or unexpected saga result")
)

// ReserveSucceeded is the definitive result from the owner of asset.reserve.
// The participant must durably record its own side effect before emitting it.
type ReserveSucceeded struct {
	TenantID     string
	SagaID       string
	CommandID    string
	ResultID     string
	SagaVersion  int64
	FencingToken int64
}

// ApplyReserveSucceeded records the result and queues asset.configure in the
// same transaction. The saga row lock serializes competing and replayed results;
// version and fencing checks reject a result from a superseded command.
func (s Store) ApplyReserveSucceeded(ctx context.Context, result ReserveSucceeded) (Snapshot, error) {
	if !common.TenantPattern.MatchString(result.TenantID) ||
		!common.TenantPattern.MatchString(result.SagaID) ||
		!common.TenantPattern.MatchString(result.CommandID) ||
		!common.TenantPattern.MatchString(result.ResultID) ||
		result.SagaVersion < 1 || result.FencingToken < 1 {
		return Snapshot{}, ErrInvalidRequest
	}
	var snap Snapshot
	err := common.WithTenantSchema(ctx, s.DB, result.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		var err error
		snap, err = applyReserveSucceededTx(ctx, tx, result)
		return err
	})
	if err != nil {
		return Snapshot{}, err
	}
	return snap, nil
}

func applyReserveSucceededTx(ctx context.Context, tx pgx.Tx, result ReserveSucceeded) (Snapshot, error) {
	snap, err := lockResultSaga(ctx, tx, result)
	if err != nil {
		return Snapshot{}, err
	}
	if err := validateReserveCommand(ctx, tx, result); err != nil {
		return Snapshot{}, err
	}
	alreadyApplied, err := reserveResultAlreadyApplied(ctx, tx, result)
	if err != nil {
		return Snapshot{}, err
	}
	if alreadyApplied {
		return snap, nil
	}
	if snap.State != "reserving" || snap.Version != result.SagaVersion || snap.FencingToken != result.FencingToken {
		return Snapshot{}, ErrStaleResult
	}

	_, err = tx.Exec(ctx, `INSERT INTO saga_result_inbox
		(tenant_id, result_id, saga_id, command_id, outcome)
		VALUES ($1, $2, $3, $4, 'succeeded')`,
		result.TenantID, result.ResultID, result.SagaID, result.CommandID)
	if err != nil {
		return Snapshot{}, fmt.Errorf("record reserve result: %w", err)
	}
	err = tx.QueryRow(ctx, `UPDATE provisioning_sagas SET state='configuring', version=version+1,
		deadline_at=now() + interval '15 minutes', updated_at=now()
		WHERE tenant_id=$1 AND saga_id=$2 RETURNING version, deadline_at`,
		result.TenantID, result.SagaID).Scan(&snap.Version, &snap.DeadlineAt)
	if err != nil {
		return Snapshot{}, fmt.Errorf("advance saga: %w", err)
	}
	snap.State = "configuring"
	_, err = tx.Exec(ctx, `INSERT INTO saga_command_outbox
		(tenant_id, saga_id, step, saga_version, fencing_token, payload)
		VALUES ($1, $2, 'asset.configure', $3, $4,
		jsonb_build_object('tenant_id', ($1::uuid)::text, 'saga_id', ($2::uuid)::text,
		'device_id', ($5::uuid)::text, 'asset_id', ($6::uuid)::text))`,
		result.TenantID, result.SagaID, snap.Version, snap.FencingToken, snap.DeviceID, snap.AssetID)
	if err != nil {
		return Snapshot{}, fmt.Errorf("queue configure command: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO saga_audit (tenant_id, saga_id, version, action)
		VALUES ($1, $2, $3, 'asset.reserved')`, result.TenantID, result.SagaID, snap.Version)
	if err != nil {
		return Snapshot{}, fmt.Errorf("record reserve audit: %w", err)
	}
	return snap, nil
}

func lockResultSaga(ctx context.Context, tx pgx.Tx, result ReserveSucceeded) (Snapshot, error) {
	snap := Snapshot{TenantID: result.TenantID, SagaID: result.SagaID}
	err := tx.QueryRow(ctx, `SELECT device_id, asset_id, state, version, fencing_token, deadline_at
		FROM provisioning_sagas WHERE tenant_id=$1 AND saga_id=$2 FOR UPDATE`,
		result.TenantID, result.SagaID).Scan(&snap.DeviceID, &snap.AssetID, &snap.State,
		&snap.Version, &snap.FencingToken, &snap.DeadlineAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Snapshot{}, ErrSagaNotFound
	}
	if err != nil {
		return Snapshot{}, fmt.Errorf("lock saga: %w", err)
	}
	return snap, nil
}

func validateReserveCommand(ctx context.Context, tx pgx.Tx, result ReserveSucceeded) error {
	var step string
	var commandVersion, commandFence int64
	err := tx.QueryRow(ctx, `SELECT step, saga_version, fencing_token FROM saga_command_outbox
		WHERE tenant_id=$1 AND saga_id=$2 AND command_id=$3`,
		result.TenantID, result.SagaID, result.CommandID).Scan(&step, &commandVersion, &commandFence)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrStaleResult
	}
	if err != nil {
		return fmt.Errorf("read result command: %w", err)
	}
	if step != "asset.reserve" || commandVersion != result.SagaVersion || commandFence != result.FencingToken {
		return ErrStaleResult
	}
	return nil
}

func reserveResultAlreadyApplied(ctx context.Context, tx pgx.Tx, result ReserveSucceeded) (bool, error) {
	var existingCommand, existingOutcome string
	err := tx.QueryRow(ctx, `SELECT command_id, outcome FROM saga_result_inbox
		WHERE tenant_id=$1 AND result_id=$2`, result.TenantID, result.ResultID).Scan(&existingCommand, &existingOutcome)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("read result identity: %w", err)
	}
	if err == nil && (existingCommand != result.CommandID || existingOutcome != "succeeded") {
		return false, ErrResultConflict
	}
	err = tx.QueryRow(ctx, `SELECT outcome FROM saga_result_inbox
		WHERE tenant_id=$1 AND command_id=$2`, result.TenantID, result.CommandID).Scan(&existingOutcome)
	if err == nil {
		if existingOutcome != "succeeded" {
			return false, ErrResultConflict
		}
		return true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("read command receipt: %w", err)
	}
	return false, nil
}
