package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// pendingBindingResult leaves one completed, unpublished binding result.
func pendingBindingResult(t *testing.T, db TxStarter, tenant string) {
	t.Helper()
	command := BindingAwaitCommand{TenantID: tenant, SagaID: randomUUID(), CommandID: randomUUID(),
		DeviceID: randomUUID(), SagaVersion: 1, FencingToken: 1}
	if err := RegisterBindingAwait(context.Background(), db, command); err != nil {
		t.Fatal(err)
	}
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: tenant, device: command.DeviceID, version: 1}, BindingApplied)
}

func TestBindingResultTenantDiscoveryIsIDOnlyBoundedAndFair(t *testing.T) {
	db := pooled(t, 4)
	ctx := context.Background()
	ours := make([]string, maxBindingTenantsPerPass+20)
	mine := map[string]bool{}
	for i := range ours {
		ours[i] = randomUUID()
		mine[ours[i]] = true
		pendingBindingResult(t, db, ours[i])
	}
	heavy := ours[0]
	for i := 0; i < maxBindingResultsPerTenant+3; i++ {
		pendingBindingResult(t, db, heavy)
	}
	count := selectorTenantCount(ctx, t, db)
	if count > maxBindingTenantsPerPass {
		t.Fatalf("selector batch not clamped: %d", count)
	}
	// Publish only this test's tenants while walking the real selector/cursor.
	include := func(id string) bool { return mine[id] }
	perTenant := map[string]int{}
	seen := map[string]bool{}
	publish := func(_ context.Context, key, value []byte) error {
		var r BindingResult
		if err := json.Unmarshal(value, &r); err != nil {
			return err
		}
		if !mine[r.TenantID] || string(key) != r.TenantID+":"+r.SagaID || seen[r.ResultID] {
			t.Fatalf("crossed tenant or duplicate result: key=%s %+v", key, r)
		}
		seen[r.ResultID] = true
		perTenant[r.TenantID]++
		return nil
	}
	cursor, passes := "", 0
	var err error
	for ; passes < 60 && (len(perTenant) < len(ours) || perTenant[heavy] < maxBindingResultsPerTenant+4); passes++ {
		if cursor, err = publishBindingResultsPass(ctx, db, cursor, bindingResultTenants, include, publish); err != nil {
			t.Fatal(err)
		}
	}
	if len(perTenant) != len(ours) || perTenant[heavy] != maxBindingResultsPerTenant+4 {
		t.Fatalf("starved after %d passes: tenants=%d heavy=%d", passes, len(perTenant), perTenant[heavy])
	}
	assertTenantDrained(ctx, t, db, heavy)
	t.Logf("tenants=%d passes=%d initial_selector_batch=%d", len(ours), passes, count)
}

// selectorTenantCount checks the selector returns only tenant IDs and that the
// runtime role sees no rows without tenant context.
func selectorTenantCount(ctx context.Context, t *testing.T, db *pgxpool.Pool) int {
	t.Helper()
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT * FROM saga_binding_result_tenants(NULL, 100000)`)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for rows.Next() {
		if n := len(rows.FieldDescriptions()); n != 1 {
			t.Fatalf("selector must return tenant IDs only, got %d columns", n)
		}
		count++
	}
	rows.Close()
	var visible int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM saga_binding_requests`).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("runtime role enumerated rows without tenant context: %d %v", visible, err)
	}
	return count
}

func assertTenantDrained(ctx context.Context, t *testing.T, db TxStarter, tenant string) {
	t.Helper()
	var left int
	if err := WithTenant(ctx, db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM saga_binding_requests WHERE tenant_id=$1 AND published_at IS NULL AND outcome='succeeded'`, tenant).Scan(&left)
	}); err != nil || left != 0 {
		t.Fatalf("heavy tenant not drained: %d %v", left, err)
	}
}
