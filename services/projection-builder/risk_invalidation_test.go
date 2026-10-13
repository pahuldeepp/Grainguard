package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func riskWithdrawal(t *testing.T, assessment map[string]any) map[string]any {
	t.Helper()
	p := assessment[fieldPayload].(map[string]any)
	return map[string]any{
		fieldTenant: assessment[fieldTenant], fieldEvent: randomUUID(), fieldType: typeRiskInvalidated, fieldSchema: 1,
		fieldAggregate: assessment[fieldAggregate], fieldAggregateType: "device_risk_stream", fieldVersion: "2", fieldOccurred: "2026-10-03T13:00:00Z",
		fieldCorrelation: randomUUID(), fieldCausation: randomUUID(), fieldTrace: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
		fieldPayload: map[string]any{"assessment_id": p["assessment_id"], "assessment_version": assessment[fieldVersion], "device_id": p["device_id"], "reading_id": p["reading_id"], "source_event_id": p["source_event_id"], "bin_id": p["bin_id"], "previous_lot_id": p["lot_id"], "replacement_lot_id": randomUUID(), "replacement_occupancy_version": "2", "observed_at": "2026-10-03T12:00:00Z", "effective_from": "2026-10-03T11:00:00Z", "reason": "backdated_lot_placement"},
	}
}

func TestRiskWithdrawalSchemaRoutingAndIndependentReplay(t *testing.T) {
	schemas, err := loadSchemas("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	a := domainFixture(t, "risk-assessed.v2.valid.json")
	withdrawal := riskWithdrawal(t, a)
	if bad := schemas.Validate(withdrawal); bad != nil {
		t.Fatal(bad)
	}
	if route(withdrawal) != topicRiskInvalidated {
		t.Fatal("withdrawal topic missing")
	}
	bodyA, _ := json.Marshal(a)
	bodyW, _ := json.Marshal(withdrawal)
	first, err := referenceFoldAt([][]byte{bodyW, bodyA}, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := referenceFoldAt([][]byte{bodyA, bodyW}, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) || len(first.Invalidations) != 1 || len(first.Assessments) != 1 {
		t.Fatal("replay order changed withdrawal state")
	}
	withdrawal[fieldPayload].(map[string]any)["device_id"] = randomUUID()
	if schemas.Validate(withdrawal) == nil {
		t.Fatal("mismatched device admitted")
	}
	withdrawal = riskWithdrawal(t, a)
	withdrawal[fieldPayload].(map[string]any)["assessment_version"] = "9223372036854775808"
	if schemas.Validate(withdrawal) == nil {
		t.Fatal("bigint overflow admitted")
	}
}

func TestRiskWithdrawalEffectRejectsConflictingTargets(t *testing.T) {
	a := domainFixture(t, "risk-assessed.v2.valid.json")
	w := riskWithdrawal(t, a)
	for _, event := range []map[string]any{a, w} {
		tx := &scriptedTx{row: func(string) rowResult { return rowResult{values: []any{true}} }}
		err := applyEffect(context.Background(), tx, event, 24*time.Hour, nil)
		var bad *failure
		if !errors.As(err, &bad) || !strings.Contains(bad.Detail, "identity conflicts") {
			t.Fatalf("conflict=%v", err)
		}
		for _, q := range tx.queries {
			if strings.Contains(q, "INSERT INTO risk_") {
				t.Fatal("conflict wrote effect")
			}
		}
	}
}

// This test runs entirely inside one outer transaction in the existing local
// database, exercises actual projection effect SQL as projection_app, and proves
// rollback removes both assessment and pre-arrival withdrawal effects.
func TestRiskWithdrawalRollbackOnlyPostgres(t *testing.T) {
	if os.Getenv("RISK_INVALIDATION_LIVE") != "1" {
		t.Skip("RISK_INVALIDATION_LIVE=1 required")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL(t, envOrSkip(t, "POSTGRES_ADMIN_URL"), "greenguard_read"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var tenant string
	if err = tx.QueryRow(ctx, `SELECT tenant_id::text FROM greenguard_internal.tenant_ownership WHERE state='active' AND tenant_id<>$1::uuid LIMIT 1`, infrastructureTenant).Scan(&tenant); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenant); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `SET LOCAL ROLE projection_app`); err != nil {
		t.Fatal(err)
	}
	if err = admitProjectionTenant(ctx, tx, tenant); err != nil {
		t.Fatal(err)
	}
	a := domainFixture(t, "risk-assessed.v2.valid.json")
	a[fieldTenant], a[fieldEvent], a[fieldAggregate] = tenant, randomUUID(), randomUUID()
	p := a[fieldPayload].(map[string]any)
	p["assessment_id"], p["device_id"] = randomUUID(), a[fieldAggregate]
	w := riskWithdrawal(t, a)
	for index, event := range []map[string]any{w, a} {
		raw, _ := json.Marshal(event)
		if _, err = tx.Exec(ctx, `INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event) VALUES('projection-builder',$1,$2,'rollback-risk',0,$3,$4::jsonb)`, tenant, event[fieldEvent], index, string(raw)); err != nil {
			t.Fatal(err)
		}
		if err = applyEffect(ctx, tx, event, 24*time.Hour, nil); err != nil {
			t.Fatal(err)
		}
	}

	// Inbox identity is the durable idempotency boundary: same envelope cannot
	// reapply the ledger effect. A different withdrawal event remains retained.
	raw, _ := json.Marshal(w)
	tag, err := tx.Exec(ctx, `INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event) VALUES('projection-builder',$1,$2,'rollback-risk',0,0,$3::jsonb) ON CONFLICT(consumer_name,tenant_id,event_id) DO NOTHING`, tenant, w[fieldEvent], string(raw))
	if err != nil || tag.RowsAffected() != 0 {
		t.Fatalf("duplicate inbox admission: %v %v", tag, err)
	}
	second := riskWithdrawal(t, a)
	second[fieldVersion] = "3"
	raw, _ = json.Marshal(second)
	if _, err = tx.Exec(ctx, `INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event) VALUES('projection-builder',$1,$2,'rollback-risk',0,2,$3::jsonb)`, tenant, second[fieldEvent], string(raw)); err != nil {
		t.Fatal(err)
	}
	if err = applyRiskInvalidation(ctx, tx, second); err != nil {
		t.Fatal(err)
	}
	// A corrected replacement assessment gets its own immutable identity and
	// remains visible; withdrawal of the predecessor does not taint replacements.
	replacement := domainFixture(t, "risk-assessed.v2.valid.json")
	replacement[fieldTenant], replacement[fieldEvent], replacement[fieldAggregate], replacement[fieldVersion] = tenant, randomUUID(), a[fieldAggregate], "4"
	rp := replacement[fieldPayload].(map[string]any)
	rp["assessment_id"], rp["device_id"], rp["lot_id"] = randomUUID(), a[fieldAggregate], w[fieldPayload].(map[string]any)["replacement_lot_id"]
	raw, _ = json.Marshal(replacement)
	if _, err = tx.Exec(ctx, `INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event) VALUES('projection-builder',$1,$2,'rollback-risk',0,3,$3::jsonb)`, tenant, replacement[fieldEvent], string(raw)); err != nil {
		t.Fatal(err)
	}
	if err = applyRiskAssessment(ctx, tx, replacement); err != nil {
		t.Fatal(err)
	}
	var visible int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM risk_assessments a WHERE tenant_id=$1 AND assessment_id=$2 AND NOT EXISTS(SELECT 1 FROM risk_assessment_invalidations i WHERE i.tenant_id=$1 AND i.assessment_id=a.assessment_id)`, tenant, rp["assessment_id"]).Scan(&visible); err != nil || visible != 1 {
		t.Fatalf("replacement visibility: %d %v", visible, err)
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM risk_assessments a WHERE tenant_id=$1 AND assessment_id=$2 AND NOT EXISTS(SELECT 1 FROM risk_assessment_invalidations i WHERE i.tenant_id=$1 AND i.assessment_id=a.assessment_id)`, tenant, p["assessment_id"]).Scan(&count); err != nil || count != 0 {
		t.Fatalf("withdrawn assessment visible: %d %v", count, err)
	}
	if _, err = tx.Exec(ctx, `SAVEPOINT conflicting_target`); err != nil {
		t.Fatal(err)
	}
	conflicting := riskWithdrawal(t, a)
	conflicting[fieldPayload].(map[string]any)["previous_lot_id"] = randomUUID()
	if err = applyRiskInvalidation(ctx, tx, conflicting); err == nil {
		t.Fatal("identity conflict accepted")
	}
	if _, err = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT conflicting_target`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM public.risk_assessment_invalidations WHERE tenant_id=$1 AND event_id=$2`, tenant, w[fieldEvent]).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback ledger persisted: %d %v", count, err)
	}
}
