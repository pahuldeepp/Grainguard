package saga

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
)

var ErrRepairState = errors.New("saga does not require repair")

type RedriveRequest struct {
	TenantID, SagaID, ActorSub, Reason string
}

// Redrive replays an unconfirmed command under its original identity. A new
// command is issued only after a definitive rejection of a compensation step.
func (s Store) Redrive(ctx context.Context, req RedriveRequest) (Snapshot, error) {
	if !common.TenantPattern.MatchString(req.TenantID) || !common.TenantPattern.MatchString(req.SagaID) ||
		strings.TrimSpace(req.ActorSub) == "" || len(req.ActorSub) > 256 ||
		strings.TrimSpace(req.Reason) == "" || len(req.Reason) > 1024 {
		return Snapshot{}, ErrInvalidRequest
	}
	var snap Snapshot
	err := common.WithTenantSchema(ctx, s.DB, req.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		var err error
		snap, err = redriveTx(ctx, tx, req)
		return err
	})
	if err != nil {
		return Snapshot{}, err
	}
	return snap, nil
}

func redriveTx(ctx context.Context, tx pgx.Tx, req RedriveRequest) (Snapshot, error) {
	snap := Snapshot{TenantID: req.TenantID, SagaID: req.SagaID}
	err := tx.QueryRow(ctx, `SELECT device_id, asset_id, state, version, fencing_token, deadline_at
		FROM provisioning_sagas WHERE tenant_id=$1 AND saga_id=$2 FOR UPDATE`, req.TenantID, req.SagaID).Scan(
		&snap.DeviceID, &snap.AssetID, &snap.State, &snap.Version, &snap.FencingToken, &snap.DeadlineAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Snapshot{}, ErrSagaNotFound
	}
	if err != nil {
		return Snapshot{}, err
	}
	if snap.State != "repair_required" {
		return Snapshot{}, ErrRepairState
	}
	var step, commandID string
	var commandVersion, commandFence int64
	err = tx.QueryRow(ctx, `SELECT step, command_id, saga_version, fencing_token FROM saga_command_outbox WHERE tenant_id=$1 AND saga_id=$2
		ORDER BY saga_version DESC, created_at DESC LIMIT 1`, req.TenantID, req.SagaID).Scan(&step, &commandID, &commandVersion, &commandFence)
	if err != nil {
		return Snapshot{}, fmt.Errorf("find repair step: %w", err)
	}
	state := map[string]string{
		"asset.reserve": "reserving", "asset.configure": "configuring",
		"inventory.activate": "activating", "binding.await": "activating",
		"inventory.deactivate": "compensating", stepAssetRelease: "compensating",
	}[step]
	if state == "" {
		return Snapshot{}, ErrRepairState
	}
	var outcome string
	err = tx.QueryRow(ctx, `SELECT outcome FROM saga_result_inbox WHERE tenant_id=$1 AND command_id=$2`, req.TenantID, commandID).Scan(&outcome)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Snapshot{}, err
	}
	if outcome == "" {
		if snap.Version != commandVersion || snap.FencingToken != commandFence {
			return Snapshot{}, ErrRepairState
		}
		return replayCommandTx(ctx, tx, req, snap, state, commandID)
	}
	if outcome != "rejected" || (step != stepAssetRelease && step != "inventory.deactivate") {
		return Snapshot{}, ErrRepairState
	}
	return reissueCompensationTx(ctx, tx, req, snap, state, step)
}

// replayCommandTx re-publishes the unconfirmed command under its original
// identity, version and fencing token.
func replayCommandTx(ctx context.Context, tx pgx.Tx, req RedriveRequest, snap Snapshot, state, commandID string) (Snapshot, error) {
	err := tx.QueryRow(ctx, `UPDATE provisioning_sagas SET state=$3, deadline_at=now()+interval '15 minutes',
		updated_at=now() WHERE tenant_id=$1 AND saga_id=$2 RETURNING deadline_at`, req.TenantID, req.SagaID, state).Scan(&snap.DeadlineAt)
	if err != nil {
		return Snapshot{}, err
	}
	snap.State = state
	trace, err := ensureSagaTrace(ctx, tx, req.TenantID, req.SagaID, snap.Version)
	if err != nil {
		return Snapshot{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE saga_command_outbox SET published_at=NULL, traceparent=COALESCE(traceparent, $3)
		WHERE tenant_id=$1 AND command_id=$2`, req.TenantID, commandID, trace)
	if err != nil {
		return Snapshot{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO saga_audit (tenant_id,saga_id,version,action,actor_sub,reason)
		VALUES ($1,$2,$3,'operator.replay',$4,$5)`, req.TenantID, req.SagaID, snap.Version, req.ActorSub, req.Reason)
	return snap, err
}

// reissueCompensationTx advances version and fencing token and queues a new
// command after a definitive compensation rejection.
func reissueCompensationTx(ctx context.Context, tx pgx.Tx, req RedriveRequest, snap Snapshot, state, step string) (Snapshot, error) {
	err := tx.QueryRow(ctx, `UPDATE provisioning_sagas SET state=$3, version=version+1,
		fencing_token=fencing_token+1, deadline_at=now()+interval '15 minutes', updated_at=now()
		WHERE tenant_id=$1 AND saga_id=$2 RETURNING version, fencing_token, deadline_at`,
		req.TenantID, req.SagaID, state).Scan(&snap.Version, &snap.FencingToken, &snap.DeadlineAt)
	if err != nil {
		return Snapshot{}, err
	}
	snap.State = state
	if err := queueCommand(ctx, tx, snap, step); err != nil {
		return Snapshot{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO saga_audit (tenant_id,saga_id,version,action,actor_sub,reason)
		VALUES ($1,$2,$3,'operator.redrive',$4,$5)`, req.TenantID, req.SagaID, snap.Version, req.ActorSub, req.Reason)
	if err != nil {
		return Snapshot{}, fmt.Errorf("audit redrive: %w", err)
	}
	return snap, nil
}
