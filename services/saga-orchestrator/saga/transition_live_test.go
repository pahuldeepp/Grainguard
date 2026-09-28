package saga

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

func startTransitionTest(t *testing.T, ctx context.Context, s Store, tenant, asset string) Snapshot {
	t.Helper()
	snap, err := s.Start(ctx, StartRequest{
		TenantID: tenant, IdempotencyKey: testUUID(t), DeviceID: testUUID(t), AssetID: asset,
	})
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func applyTestStep(t *testing.T, ctx context.Context, pool *pgxpool.Pool, s Store, snap Snapshot, step, outcome string) Snapshot {
	t.Helper()
	var commandID string
	if err := common.WithTenantSchema(ctx, pool, snap.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT command_id FROM saga_command_outbox
			WHERE tenant_id=$1 AND saga_id=$2 AND saga_version=$3 AND step=$4`,
			snap.TenantID, snap.SagaID, snap.Version, step).Scan(&commandID)
	}); err != nil {
		t.Fatal(err)
	}
	next, err := s.ApplyStepResult(ctx, StepResult{
		TenantID: snap.TenantID, SagaID: snap.SagaID, CommandID: commandID,
		ResultID: testUUID(t), SagaVersion: snap.Version, FencingToken: snap.FencingToken,
		Outcome: outcome,
	})
	if err != nil {
		t.Fatalf("%s %s: %v", step, outcome, err)
	}
	return next
}

func TestLiveProvisioningSuccessTransitions(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	snap := startTransitionTest(t, ctx, s, testUUID(t), testUUID(t))
	for _, item := range []struct{ step, state string }{
		{"asset.reserve", "configuring"},
		{"asset.configure", "activating"},
		{"inventory.activate", "activating"},
		{"binding.await", "active"},
	} {
		snap = applyTestStep(t, ctx, pool, s, snap, item.step, "succeeded")
		if snap.State != item.state {
			t.Fatalf("after %s got %s, want %s", item.step, snap.State, item.state)
		}
	}
	if snap.Version != 5 {
		t.Fatalf("active version = %d", snap.Version)
	}
}

func TestLiveConfigureFailureCompensatesAndReleasesClaim(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	tenant, asset := testUUID(t), testUUID(t)
	snap := startTransitionTest(t, ctx, s, tenant, asset)
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.reserve", "succeeded")
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.configure", "rejected")
	if snap.State != "compensating" {
		t.Fatalf("failed configure state = %s", snap.State)
	}
	if _, err := s.Start(ctx, StartRequest{TenantID: tenant, IdempotencyKey: testUUID(t),
		DeviceID: testUUID(t), AssetID: asset}); !errors.Is(err, ErrAssetClaimed) {
		t.Fatalf("asset claim released before compensation: %v", err)
	}
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.release", "succeeded")
	if snap.State != "compensated" {
		t.Fatalf("compensation state = %s", snap.State)
	}
	startTransitionTest(t, ctx, s, tenant, asset)
}

func TestLiveBindingFailureDeactivatesBeforeRelease(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	snap := startTransitionTest(t, ctx, s, testUUID(t), testUUID(t))
	for _, step := range []string{"asset.reserve", "asset.configure", "inventory.activate"} {
		snap = applyTestStep(t, ctx, pool, s, snap, step, "succeeded")
	}
	snap = applyTestStep(t, ctx, pool, s, snap, "binding.await", "rejected")
	if snap.State != "compensating" {
		t.Fatalf("binding rejection state = %s", snap.State)
	}
	snap = applyTestStep(t, ctx, pool, s, snap, "inventory.deactivate", "succeeded")
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.release", "succeeded")
	if snap.State != "compensated" {
		t.Fatalf("final compensation state = %s", snap.State)
	}
}

func TestLiveFailedCompensationRequiresRepairAndKeepsClaim(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	tenant, asset := testUUID(t), testUUID(t)
	snap := startTransitionTest(t, ctx, s, tenant, asset)
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.reserve", "succeeded")
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.configure", "rejected")
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.release", "rejected")
	if snap.State != "repair_required" {
		t.Fatalf("failed release state = %s", snap.State)
	}
	if _, err := s.Start(ctx, StartRequest{TenantID: tenant, IdempotencyKey: testUUID(t),
		DeviceID: testUUID(t), AssetID: asset}); !errors.Is(err, ErrAssetClaimed) {
		t.Fatalf("repair-required asset claim was released: %v", err)
	}
}

func TestLiveLateAndConflictingResultsCannotSkipSteps(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	snap := startTransitionTest(t, ctx, s, testUUID(t), testUUID(t))
	var reserveCommand string
	if err := common.WithTenantSchema(ctx, pool, snap.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT command_id FROM saga_command_outbox
			WHERE tenant_id=$1 AND saga_id=$2 AND step='asset.reserve'`,
			snap.TenantID, snap.SagaID).Scan(&reserveCommand)
	}); err != nil {
		t.Fatal(err)
	}
	result := StepResult{TenantID: snap.TenantID, SagaID: snap.SagaID,
		CommandID: reserveCommand, ResultID: testUUID(t), SagaVersion: snap.Version,
		FencingToken: snap.FencingToken, Outcome: "succeeded"}
	wrongStep := result
	wrongStep.ExpectedStep = "asset.configure"
	if _, err := s.ApplyStepResult(ctx, wrongStep); !errors.Is(err, ErrStaleResult) {
		t.Fatalf("mismatched wire step accepted: %v", err)
	}
	advanced, err := s.ApplyStepResult(ctx, result)
	if err != nil || advanced.State != "configuring" {
		t.Fatalf("reserve result: %+v %v", advanced, err)
	}
	conflict := result
	conflict.ResultID = testUUID(t)
	conflict.Outcome = "rejected"
	if _, err := s.ApplyStepResult(ctx, conflict); !errors.Is(err, ErrResultConflict) {
		t.Fatalf("conflicting late reserve outcome: %v", err)
	}
	if replay, err := s.ApplyStepResult(ctx, result); err != nil || replay.Version != advanced.Version {
		t.Fatalf("duplicate result changed state: %+v %v", replay, err)
	}
	stale := result
	stale.ResultID = testUUID(t)
	stale.FencingToken++
	if _, err := s.ApplyStepResult(ctx, stale); !errors.Is(err, ErrStaleResult) {
		t.Fatalf("stale fence accepted: %v", err)
	}
}
