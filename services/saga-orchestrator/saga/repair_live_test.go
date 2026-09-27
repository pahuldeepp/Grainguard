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

func commandFor(t *testing.T, ctx context.Context, pool *pgxpool.Pool, snap Snapshot, step string) (string, int64) {
	t.Helper()
	var id string
	var version int64
	if err := common.WithTenantSchema(ctx, pool, snap.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT command_id, saga_version FROM saga_command_outbox
			WHERE tenant_id=$1 AND saga_id=$2 AND step=$3 ORDER BY saga_version DESC LIMIT 1`,
			snap.TenantID, snap.SagaID, step).Scan(&id, &version)
	}); err != nil {
		t.Fatalf("%s command: %v", step, err)
	}
	return id, version
}

func lastAudit(t *testing.T, ctx context.Context, s Store, snap Snapshot) (Snapshot, AuditEntry) {
	t.Helper()
	cur, audit, err := s.Status(ctx, snap.TenantID, snap.SagaID)
	if err != nil || len(audit) == 0 {
		t.Fatalf("status: %v", err)
	}
	return cur, audit[len(audit)-1]
}

func TestLiveTimeoutCompensatesAndReconcilesLateSuccess(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	tenant := testUUID(t)
	started := startTransitionTest(t, ctx, s, tenant, testUUID(t))
	reserveID, _ := commandFor(t, ctx, pool, started, "asset.reserve")
	expireNow(t, ctx, pool, tenant, started.SagaID)
	if n, err := s.ExpireDue(ctx, tenant, 10); err != nil || n != 1 {
		t.Fatalf("expire: %d %v", n, err)
	}
	if n, err := s.ExpireDue(ctx, tenant, 10); err != nil || n != 0 {
		t.Fatalf("repeat expire: %d %v", n, err)
	}
	cur, entry := lastAudit(t, ctx, s, started)
	if cur.State != "compensating" || cur.Version != 2 || entry.Action != "deadline.compensate" {
		t.Fatalf("timeout compensation: %+v %+v", cur, entry)
	}
	if _, v := commandFor(t, ctx, pool, cur, "asset.release"); v != 2 {
		t.Fatalf("release queued at version %d", v)
	}
	late := StepResult{TenantID: tenant, SagaID: started.SagaID, CommandID: reserveID,
		ResultID: testUUID(t), SagaVersion: 1, FencingToken: 1, Outcome: "succeeded"}
	for i := 0; i < 2; i++ {
		got, err := s.ApplyStepResult(ctx, late)
		if err != nil || got.State != "compensating" || got.Version != 2 {
			t.Fatalf("late success delivery %d must be reconciled, not applied: %+v %v", i, got, err)
		}
	}
	if _, entry = lastAudit(t, ctx, s, cur); entry.Action != "late_result.reconciled" {
		t.Fatalf("late result audit: %+v", entry)
	}
	other := late
	other.TenantID = testUUID(t)
	if _, err := s.ApplyStepResult(ctx, other); !errors.Is(err, ErrSagaNotFound) {
		t.Fatalf("cross-tenant late result: %v", err)
	}
	done := applyTestStep(t, ctx, pool, s, cur, "asset.release", "succeeded")
	if done.State != "compensated" {
		t.Fatalf("release after timeout: %+v", done)
	}
}

func TestLiveActivationTimeoutDeactivatesBeforeRelease(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	snap := startTransitionTest(t, ctx, s, testUUID(t), testUUID(t))
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.reserve", "succeeded")
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.configure", "succeeded")
	expireNow(t, ctx, pool, snap.TenantID, snap.SagaID)
	if n, err := s.ExpireDue(ctx, snap.TenantID, 10); err != nil || n != 1 {
		t.Fatalf("expire: %d %v", n, err)
	}
	cur, _ := lastAudit(t, ctx, s, snap)
	if _, v := commandFor(t, ctx, pool, cur, "inventory.deactivate"); v != cur.Version {
		t.Fatalf("deactivate not queued at current version %d", v)
	}
	cur = applyTestStep(t, ctx, pool, s, cur, "inventory.deactivate", "succeeded")
	cur = applyTestStep(t, ctx, pool, s, cur, "asset.release", "succeeded")
	if cur.State != "compensated" {
		t.Fatalf("activation timeout end state: %+v", cur)
	}
}

func TestLiveCompensationTimeoutQuarantinesAndOperatorRedrives(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	tenant, other := testUUID(t), testUUID(t)
	snap := startTransitionTest(t, ctx, s, tenant, testUUID(t))
	if _, _, err := s.Status(ctx, other, snap.SagaID); !errors.Is(err, ErrSagaNotFound) {
		t.Fatalf("cross tenant status: %v", err)
	}
	if _, err := s.Redrive(ctx, RedriveRequest{TenantID: tenant, SagaID: snap.SagaID, ActorSub: "op", Reason: "premature"}); !errors.Is(err, ErrRepairState) {
		t.Fatalf("premature redrive: %v", err)
	}
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.reserve", "succeeded")
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.configure", "rejected")
	releaseID, releaseVersion := commandFor(t, ctx, pool, snap, "asset.release")
	expireNow(t, ctx, pool, tenant, snap.SagaID)
	if n, err := s.ExpireDue(ctx, tenant, 10); err != nil || n != 1 {
		t.Fatalf("expire compensation: %d %v", n, err)
	}
	cur, entry := lastAudit(t, ctx, s, snap)
	if cur.State != "repair_required" || cur.Version != snap.Version || entry.Action != "deadline.expired" {
		t.Fatalf("quarantine: %+v %+v", cur, entry)
	}
	if _, err := s.Redrive(ctx, RedriveRequest{TenantID: tenant, SagaID: snap.SagaID, ActorSub: " ", Reason: "x"}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("anonymous redrive: %v", err)
	}
	redriven, err := s.Redrive(ctx, RedriveRequest{TenantID: tenant, SagaID: snap.SagaID, ActorSub: "operator-1", Reason: "broker restored"})
	if err != nil || redriven.State != "compensating" || redriven.Version != snap.Version {
		t.Fatalf("redrive: %+v %v", redriven, err)
	}
	if _, entry = lastAudit(t, ctx, s, snap); entry.Action != "operator.replay" || entry.ActorSub == nil || *entry.ActorSub != "operator-1" {
		t.Fatalf("redrive audit: %+v", entry)
	}
	if again, _ := commandFor(t, ctx, pool, snap, "asset.release"); again != releaseID {
		t.Fatal("replay must reuse the original release command identity")
	}
	done, err := s.ApplyStepResult(ctx, StepResult{TenantID: tenant, SagaID: snap.SagaID, CommandID: releaseID,
		ResultID: testUUID(t), SagaVersion: releaseVersion, FencingToken: 1, Outcome: "succeeded"})
	if err != nil || done.State != "compensated" {
		t.Fatalf("release after replay: %+v %v", done, err)
	}
}

func TestLiveRejectedCompensationRedriveIssuesNewFencedCommand(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	snap := startTransitionTest(t, ctx, s, testUUID(t), testUUID(t))
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.reserve", "succeeded")
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.configure", "rejected")
	oldRelease, _ := commandFor(t, ctx, pool, snap, "asset.release")
	snap = applyTestStep(t, ctx, pool, s, snap, "asset.release", "rejected")
	redriven, err := s.Redrive(ctx, RedriveRequest{TenantID: snap.TenantID, SagaID: snap.SagaID, ActorSub: "op", Reason: "hardware fixed"})
	if err != nil || redriven.State != "compensating" || redriven.FencingToken != 2 {
		t.Fatalf("redrive rejected release: %+v %v", redriven, err)
	}
	if id, _ := commandFor(t, ctx, pool, redriven, "asset.release"); id == oldRelease {
		t.Fatal("redrive after rejection must issue a new command")
	}
	done := applyTestStep(t, ctx, pool, s, redriven, "asset.release", "succeeded")
	if done.State != "compensated" {
		t.Fatalf("redriven release: %+v", done)
	}
}
