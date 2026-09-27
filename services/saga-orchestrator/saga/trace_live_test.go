package saga

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

const liveTrace = "00-" + testTraceID + "-" + testSpanID + "-00"

// publishOne publishes the tenant's next command and returns its wire form.
func publishOne(t *testing.T, ctx context.Context, s Store, tenant string) Command {
	t.Helper()
	var sent Command
	ok, err := s.PublishNextCommand(ctx, tenant, func(_ context.Context, _, value []byte) error {
		return json.Unmarshal(value, &sent)
	})
	if err != nil || !ok {
		t.Fatalf("publish: %v %v", ok, err)
	}
	return sent
}

func sagaTrace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, snap Snapshot) (string, string) {
	t.Helper()
	var tp, origin *string
	if err := common.WithTenantSchema(ctx, pool, snap.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT traceparent, trace_origin FROM provisioning_sagas
			WHERE tenant_id=$1 AND saga_id=$2`, snap.TenantID, snap.SagaID).Scan(&tp, &origin)
	}); err != nil {
		t.Fatal(err)
	}
	if tp == nil || origin == nil {
		return "", ""
	}
	return *tp, *origin
}

func tenantExec(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenant, sql string, args ...any) {
	t.Helper()
	if err := common.WithTenantSchema(ctx, pool, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestLivePropagatedTraceCrossesEveryCommand(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	tenant := testUUID(t)
	req := StartRequest{TenantID: tenant, IdempotencyKey: testUUID(t), DeviceID: testUUID(t),
		AssetID: testUUID(t), Traceparent: liveTrace}
	snap, err := s.Start(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	req.Traceparent = NewRootTraceparent()
	if again, err := s.Start(ctx, req); err != nil || again.SagaID != snap.SagaID {
		t.Fatalf("retry under another trace: %+v %v", again, err)
	}
	if tp, origin := sagaTrace(t, ctx, pool, snap); tp != liveTrace || origin != TraceOriginPropagated {
		t.Fatalf("stored trace %q %q", tp, origin)
	}
	reserve := publishOne(t, ctx, s, tenant)
	if reserve.Traceparent != liveTrace {
		t.Fatalf("reserve trace %q", reserve.Traceparent)
	}
	if _, err := s.ApplyStepResult(ctx, StepResult{TenantID: tenant, SagaID: snap.SagaID, CommandID: reserve.CommandID,
		ResultID: testUUID(t), SagaVersion: 1, FencingToken: 1, Outcome: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if configure := publishOne(t, ctx, s, tenant); configure.Step != "asset.configure" || configure.Traceparent != liveTrace {
		t.Fatalf("configure command %+v", configure)
	}
	if _, audit, err := s.Status(ctx, tenant, snap.SagaID); err != nil || audit[0].Reason == nil || *audit[0].Reason != "trace_origin=propagated" {
		t.Fatalf("start audit %+v %v", audit, err)
	}
}

func TestLiveMissingTraceGeneratesOneRootReusedByDeadlineAndRedrive(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	tenant := testUUID(t)
	snap, err := s.Start(ctx, StartRequest{TenantID: tenant, IdempotencyKey: testUUID(t),
		DeviceID: testUUID(t), AssetID: testUUID(t), Traceparent: "00-" + testTraceID + "-0000000000000000-01"})
	if err != nil {
		t.Fatal(err)
	}
	root, origin := sagaTrace(t, ctx, pool, snap)
	if origin != TraceOriginGenerated || root == "" {
		t.Fatalf("invalid header must start a generated root: %q %q", root, origin)
	}
	if reserve := publishOne(t, ctx, s, tenant); reserve.Traceparent != root {
		t.Fatalf("reserve %q root %q", reserve.Traceparent, root)
	}
	expireNow(t, ctx, pool, tenant, snap.SagaID)
	if n, err := s.ExpireDue(ctx, tenant, 10); err != nil || n != 1 {
		t.Fatalf("expire: %d %v", n, err)
	}
	release := publishOne(t, ctx, s, tenant)
	if release.Step != stepAssetRelease || release.Traceparent != root {
		t.Fatalf("deadline compensation %+v", release)
	}
	tenantExec(t, ctx, pool, tenant, `UPDATE provisioning_sagas SET state='repair_required' WHERE tenant_id=$1 AND saga_id=$2`,
		tenant, snap.SagaID)
	if _, err := s.Redrive(ctx, RedriveRequest{TenantID: tenant, SagaID: snap.SagaID, ActorSub: "op", Reason: "trace test"}); err != nil {
		t.Fatal(err)
	}
	if replay := publishOne(t, ctx, s, tenant); replay.CommandID != release.CommandID || replay.Traceparent != root {
		t.Fatalf("redrive replay %+v", replay)
	}
}

func TestLivePreMigrationRowsGetOneStoredRoot(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := Store{DB: pool}
	tenant := testUUID(t)
	snap, err := s.Start(ctx, StartRequest{TenantID: tenant, IdempotencyKey: testUUID(t),
		DeviceID: testUUID(t), AssetID: testUUID(t), Traceparent: liveTrace})
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a saga and command written before migration 000007.
	tenantExec(t, ctx, pool, tenant, `UPDATE provisioning_sagas SET traceparent=NULL, trace_origin=NULL
		WHERE tenant_id=$1 AND saga_id=$2`, tenant, snap.SagaID)
	tenantExec(t, ctx, pool, tenant, `UPDATE saga_command_outbox SET traceparent=NULL WHERE tenant_id=$1 AND saga_id=$2`,
		tenant, snap.SagaID)
	reserve := publishOne(t, ctx, s, tenant)
	root, origin := sagaTrace(t, ctx, pool, snap)
	if reserve.Traceparent == liveTrace || reserve.Traceparent != root || origin != TraceOriginGenerated {
		t.Fatalf("legacy command %q stored %q %q", reserve.Traceparent, root, origin)
	}
	if _, err := s.ApplyStepResult(ctx, StepResult{TenantID: tenant, SagaID: snap.SagaID, CommandID: reserve.CommandID,
		ResultID: testUUID(t), SagaVersion: 1, FencingToken: 1, Outcome: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if next := publishOne(t, ctx, s, tenant); next.Traceparent != root {
		t.Fatalf("later command %q root %q", next.Traceparent, root)
	}
	cur, audit, err := s.Status(ctx, tenant, snap.SagaID)
	if err != nil {
		t.Fatal(err)
	}
	generated := 0
	for _, a := range audit {
		if a.Action == "trace.generated" && a.Reason != nil && *a.Reason == "trace_origin=generated" {
			generated++
		}
	}
	if generated != 1 || cur.State != "configuring" {
		t.Fatalf("trace generated %d times; state %s", generated, cur.State)
	}
}
