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

type ReserveSucceeded struct {
	TenantID     string
	SagaID       string
	CommandID    string
	ResultID     string
	SagaVersion  int64
	FencingToken int64
}

// StepResult is a definitive participant outcome. Transport failures must be
// retried or reconciled; they are never interpreted as a business rejection.
type StepResult struct {
	TenantID     string
	SagaID       string
	CommandID    string
	ResultID     string
	SagaVersion  int64
	FencingToken int64
	Outcome      string
	ExpectedStep string // optional for direct callers; mandatory on the Kafka wire
}

type transition struct {
	expectedState string
	nextState     string
	nextStep      string
	action        string
}

const stepAssetRelease = "asset.release"

func outcomes(success, rejected transition) map[string]transition {
	return map[string]transition{"succeeded": success, "rejected": rejected}
}

var routes = map[string]map[string]transition{
	"asset.reserve": outcomes(
		transition{"reserving", "configuring", "asset.configure", "asset.reserved"},
		transition{"reserving", "compensated", "", "asset.reserve_rejected"},
	),
	"asset.configure": outcomes(
		transition{"configuring", "activating", "inventory.activate", "asset.configured"},
		transition{"configuring", "compensating", stepAssetRelease, "asset.configure_rejected"},
	),
	"inventory.activate": outcomes(
		transition{"activating", "activating", "binding.await", "inventory.activated"},
		transition{"activating", "compensating", stepAssetRelease, "inventory.activate_rejected"},
	),
	"binding.await": outcomes(
		transition{"activating", "active", "", "binding.ready"},
		transition{"activating", "compensating", "inventory.deactivate", "binding.rejected"},
	),
	"inventory.deactivate": outcomes(
		transition{"compensating", "compensating", stepAssetRelease, "inventory.deactivated"},
		transition{"compensating", "repair_required", "", "inventory.deactivate_rejected"},
	),
	stepAssetRelease: outcomes(
		transition{"compensating", "compensated", "", "asset.released"},
		transition{"compensating", "repair_required", "", "asset.release_rejected"},
	),
}

func (s Store) ApplyReserveSucceeded(ctx context.Context, result ReserveSucceeded) (Snapshot, error) {
	return s.ApplyStepResult(ctx, StepResult{
		TenantID: result.TenantID, SagaID: result.SagaID, CommandID: result.CommandID,
		ResultID: result.ResultID, SagaVersion: result.SagaVersion,
		FencingToken: result.FencingToken, Outcome: "succeeded",
	})
}

// ApplyStepResult records one receipt, state change, next command, and audit
// row in one tenant transaction. The saga row lock serializes competing results.
func (s Store) ApplyStepResult(ctx context.Context, result StepResult) (Snapshot, error) {
	if !common.TenantPattern.MatchString(result.TenantID) ||
		!common.TenantPattern.MatchString(result.SagaID) ||
		!common.TenantPattern.MatchString(result.CommandID) ||
		!common.TenantPattern.MatchString(result.ResultID) ||
		result.SagaVersion < 1 || result.FencingToken < 1 ||
		(result.Outcome != "succeeded" && result.Outcome != "rejected") {
		return Snapshot{}, ErrInvalidRequest
	}
	var snap Snapshot
	err := common.WithTenantSchema(ctx, s.DB, result.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		var err error
		snap, err = applyStepResultTx(ctx, tx, result)
		return err
	})
	if err != nil {
		return Snapshot{}, err
	}
	return snap, nil
}

func applyStepResultTx(ctx context.Context, tx pgx.Tx, result StepResult) (Snapshot, error) {
	snap, err := lockResultSaga(ctx, tx, result)
	if err != nil {
		return Snapshot{}, err
	}
	step, err := loadResultCommand(ctx, tx, result)
	if err != nil {
		return Snapshot{}, err
	}
	if result.ExpectedStep != "" && result.ExpectedStep != step {
		return Snapshot{}, ErrStaleResult
	}
	alreadyApplied, err := resultAlreadyApplied(ctx, tx, result)
	if err != nil {
		return Snapshot{}, err
	}
	if alreadyApplied {
		return snap, nil
	}
	byOutcome, ok := routes[step]
	if !ok {
		return Snapshot{}, ErrStaleResult
	}
	next, ok := byOutcome[result.Outcome]
	if !ok {
		return Snapshot{}, ErrStaleResult
	}
	if lateAfterCancellation(snap, result) {
		return reconcileLateResult(ctx, tx, result, snap, step)
	}
	// A timed-out compensation is quarantined, not cancelled. Its late definitive
	// result is still authoritative while the original version/fence matches.
	if (snap.State != next.expectedState && snap.State != "repair_required") ||
		snap.Version != result.SagaVersion || snap.FencingToken != result.FencingToken {
		return Snapshot{}, ErrStaleResult
	}
	return persistStepResult(ctx, tx, result, snap, next)
}

// lateAfterCancellation identifies the definitive answer to a command that a
// deadline or rejection already superseded with compensation.
func lateAfterCancellation(snap Snapshot, result StepResult) bool {
	switch snap.State {
	case "compensating", "compensated", "repair_required":
		return result.SagaVersion < snap.Version
	}
	return false
}

// reconcileLateResult records the late outcome and its audit but never changes
// state: the compensation queued after that command (same Kafka key, later
// offset) already undoes a late success. It is therefore neither silently
// dropped nor accepted as progress.
func reconcileLateResult(ctx context.Context, tx pgx.Tx, result StepResult, snap Snapshot, step string) (Snapshot, error) {
	_, err := tx.Exec(ctx, `INSERT INTO saga_result_inbox
		(tenant_id, result_id, saga_id, command_id, outcome) VALUES ($1, $2, $3, $4, $5)`,
		result.TenantID, result.ResultID, result.SagaID, result.CommandID, result.Outcome)
	if err != nil {
		return Snapshot{}, fmt.Errorf("record late result: %w", err)
	}
	return snap, audit(ctx, tx, result.TenantID, result.SagaID, snap.Version,
		"late_result.reconciled", step+" "+result.Outcome+" after cancellation")
}

func lockResultSaga(ctx context.Context, tx pgx.Tx, result StepResult) (Snapshot, error) {
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

func loadResultCommand(ctx context.Context, tx pgx.Tx, result StepResult) (string, error) {
	var step string
	var version, fence int64
	err := tx.QueryRow(ctx, `SELECT step, saga_version, fencing_token FROM saga_command_outbox
		WHERE tenant_id=$1 AND saga_id=$2 AND command_id=$3`,
		result.TenantID, result.SagaID, result.CommandID).Scan(&step, &version, &fence)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrStaleResult
	}
	if err != nil {
		return "", fmt.Errorf("read result command: %w", err)
	}
	if version != result.SagaVersion || fence != result.FencingToken {
		return "", ErrStaleResult
	}
	return step, nil
}

func resultAlreadyApplied(ctx context.Context, tx pgx.Tx, result StepResult) (bool, error) {
	var existingCommand, existingOutcome string
	err := tx.QueryRow(ctx, `SELECT command_id, outcome FROM saga_result_inbox
		WHERE tenant_id=$1 AND result_id=$2`, result.TenantID, result.ResultID).Scan(&existingCommand, &existingOutcome)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("read result identity: %w", err)
	}
	if err == nil && (existingCommand != result.CommandID || existingOutcome != result.Outcome) {
		return false, ErrResultConflict
	}
	return commandResultAlreadyApplied(ctx, tx, result)
}

func commandResultAlreadyApplied(ctx context.Context, tx pgx.Tx, result StepResult) (bool, error) {
	var existingOutcome string
	err := tx.QueryRow(ctx, `SELECT outcome FROM saga_result_inbox
		WHERE tenant_id=$1 AND command_id=$2`, result.TenantID, result.CommandID).Scan(&existingOutcome)
	if err == nil {
		if existingOutcome != result.Outcome {
			return false, ErrResultConflict
		}
		return true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("read command receipt: %w", err)
	}
	return false, nil
}

func persistStepResult(ctx context.Context, tx pgx.Tx, result StepResult, snap Snapshot, next transition) (Snapshot, error) {
	_, err := tx.Exec(ctx, `INSERT INTO saga_result_inbox
		(tenant_id, result_id, saga_id, command_id, outcome) VALUES ($1, $2, $3, $4, $5)`,
		result.TenantID, result.ResultID, result.SagaID, result.CommandID, result.Outcome)
	if err != nil {
		return Snapshot{}, fmt.Errorf("record step result: %w", err)
	}
	err = tx.QueryRow(ctx, `UPDATE provisioning_sagas SET state=$3, version=version+1,
		deadline_at=now() + interval '15 minutes', updated_at=now()
		WHERE tenant_id=$1 AND saga_id=$2 RETURNING version, deadline_at`,
		result.TenantID, result.SagaID, next.nextState).Scan(&snap.Version, &snap.DeadlineAt)
	if err != nil {
		return Snapshot{}, fmt.Errorf("advance saga: %w", err)
	}
	snap.State = next.nextState
	if next.nextStep != "" {
		if err := queueCommand(ctx, tx, snap, next.nextStep); err != nil {
			return Snapshot{}, err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO saga_audit (tenant_id, saga_id, version, action)
		VALUES ($1, $2, $3, $4)`, result.TenantID, result.SagaID, snap.Version, next.action)
	if err != nil {
		return Snapshot{}, fmt.Errorf("record step audit: %w", err)
	}
	return snap, nil
}
