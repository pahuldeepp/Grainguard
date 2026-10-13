package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func domainFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	body, err := os.ReadFile("../../tests/fixtures/events/" + name)
	if err != nil {
		t.Fatal(err)
	}
	value, err := decode(body)
	if err != nil {
		t.Fatal(err)
	}
	return value.(map[string]any)
}

func applyDomainEvent(t *testing.T, ctx context.Context, store *Store, event map[string]any) []byte {
	t.Helper()
	if failure := semantic(event); failure != nil {
		t.Fatalf("invalid test event: %v", failure)
	}
	m := message(event)
	if err := store.Apply(ctx, m, event); err != nil {
		t.Fatalf("apply %s: %v", event[fieldType], err)
	}
	body, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func directReadQueryDatabaseURL(t *testing.T, database string) string {
	t.Helper()
	readURL, err := url.Parse(envOrSkip(t, "READ_QUERY_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	directURL, err := url.Parse(envOrSkip(t, "PROJECTION_DIRECT_URL"))
	if err != nil {
		t.Fatal(err)
	}
	// Scratch databases are not registered in PgBouncer's static database map.
	// Keep the read_query credentials, but connect over the direct PostgreSQL
	// endpoint just as the owner/runtime pools do.
	readURL.Host = directURL.Host
	readURL.Path = "/" + database
	return readURL.String()
}

// This exercises the owner envelopes, the writer transaction, public views and
// the independent replay comparison against a disposable PostgreSQL database.
func TestDomainProductProjectionIsIdempotentAndReplayComparable(t *testing.T) {
	ctx := context.Background()
	db := scratchHistoryDB(t, true)
	store := &Store{DB: db.runtime}
	var databaseName string
	if err := db.owner.QueryRow(ctx, `SELECT current_database()`).Scan(&databaseName); err != nil {
		t.Fatal(err)
	}
	reader := historyPool(t, directReadQueryDatabaseURL(t, databaseName))
	tenant, site, bin := randomUUID(), randomUUID(), randomUUID()
	device, cable, sensor := randomUUID(), randomUUID(), randomUUID()
	policyID, assessmentID, lotID := randomUUID(), randomUUID(), randomUUID()
	bodies := make([][]byte, 0, 8)

	// Site v2 followed by stale v1 proves the materialized label cannot rewind.
	for _, version := range []string{"2", "1"} {
		e := domainFixture(t, "site-changed.v1.valid.json")
		e[fieldTenant], e[fieldEvent], e[fieldAggregate], e[fieldVersion] = tenant, randomUUID(), site, version
		p := e[fieldPayload].(map[string]any)
		p["site_id"], p["site_version"] = site, version
		if version == "2" {
			p["name"] = "Current site"
		} else {
			p["name"] = "Stale site"
		}
		bodies = append(bodies, applyDomainEvent(t, ctx, store, e))
	}
	binEvent := domainFixture(t, "bin-changed.v1.valid.json")
	binEvent[fieldTenant], binEvent[fieldEvent], binEvent[fieldAggregate] = tenant, randomUUID(), bin
	bp := binEvent[fieldPayload].(map[string]any)
	bp["bin_id"], bp["site_id"] = bin, site
	bodies = append(bodies, applyDomainEvent(t, ctx, store, binEvent))

	layout := domainFixture(t, "cable-layout-changed.v1.valid.json")
	layout[fieldTenant], layout[fieldEvent], layout[fieldAggregate] = tenant, randomUUID(), cable
	lp := layout[fieldPayload].(map[string]any)
	lp["device_id"], lp["bin_id"], lp["cable_id"] = device, bin, cable
	lp["sensors"] = []any{map[string]any{"sensor_id": sensor, "position": json.Number("1"), "label": "Upper sensor", "depth_m": json.Number("1.5")}}
	bodies = append(bodies, applyDomainEvent(t, ctx, store, layout))

	maintainHistory(t, db)
	reading := domainFixture(t, "telemetry-recorded.v2.valid.json")
	reading[fieldTenant], reading[fieldEvent], reading[fieldAggregate] = tenant, randomUUID(), device
	rp := reading[fieldPayload].(map[string]any)
	rp["device_id"], rp["site_id"], rp["bin_id"] = device, site, bin
	rp["reading_id"], rp["source_message_id"] = randomUUID(), "task5-domain-live-reading"
	now := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	rp["observed_at"], rp["received_at"] = now.Format(time.RFC3339Nano), now.Add(time.Second).Format(time.RFC3339Nano)
	rp["sensor_observations"] = []any{map[string]any{
		"sensor_id": sensor, "metric": "co2_ppm", "value": json.Number("450"), "unit": "ppm",
		"layout_version": "1", "cable_id": cable, "position": json.Number("1"), "depth_m": json.Number("1.5"),
	}}
	bodies = append(bodies, applyDomainEvent(t, ctx, store, reading))

	effectiveFrom := now.Add(-time.Hour).Format(time.RFC3339Nano)
	policy := func(version string, effective string, supersedes any) map[string]any {
		return map[string]any{
			fieldEvent: randomUUID(), fieldType: typeRiskPolicy, fieldSchema: 1, fieldOccurred: effective,
			fieldTenant: tenant, fieldAggregateType: "grain_policy", fieldAggregate: policyID,
			fieldVersion: version, fieldCorrelation: randomUUID(), fieldCausation: randomUUID(),
			fieldTrace: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			fieldPayload: map[string]any{
				"policy_id": policyID, "version": version, "grain_type": "wheat", "bin_id": bin,
				"effective_from": effective, "effective_to": nil,
				"measurement_thresholds": map[string]any{"temperature_c": map[string]any{"warning": json.Number("25"), "critical": json.Number("30"), "unit": "Cel"}},
				"risk_thresholds":        map[string]any{"warning_score": json.Number("60"), "critical_score": json.Number("80")},
				"calibrated":             true, "status": "active", "provenance": map[string]any{"source": "task5-live", "revision": version},
				"calibration_evidence": "calibration-run-1", "approved_by": "operator-1", "approved_at": effective,
				"supersedes": supersedes,
			},
		}
	}
	// Successor first: the explicit supersedes edge is resolved when the prior
	// event is replayed later, without inferring closure from version order.
	successorFrom := now.Add(-30 * time.Minute).Format(time.RFC3339Nano)
	policy2 := policy("2", successorFrom, map[string]any{"policy_id": policyID, "version": "1"})
	bodies = append(bodies, applyDomainEvent(t, ctx, store, policy2))
	policy1 := policy("1", effectiveFrom, nil)
	policy1[fieldPayload].(map[string]any)["policy_id"] = policyID
	bodies = append(bodies, applyDomainEvent(t, ctx, store, policy1))

	assessment := domainFixture(t, "risk-assessed.v2.valid.json")
	assessment[fieldTenant], assessment[fieldEvent], assessment[fieldAggregate] = tenant, randomUUID(), device
	ap := assessment[fieldPayload].(map[string]any)
	ap["assessment_id"], ap["device_id"], ap["reading_id"] = assessmentID, device, rp["reading_id"]
	ap["source_event_id"], ap["bin_id"], ap["lot_id"] = reading[fieldEvent], bin, lotID
	ap["policy_id"], ap["policy_provenance"], ap["policy_calibrated"] = policyID, map[string]any{"source": "task5-live"}, true
	assessment[fieldOccurred] = now.Format(time.RFC3339Nano)
	bodies = append(bodies, applyDomainEvent(t, ctx, store, assessment))

	// Redelivery is once-in-effect and does not create duplicate history rows.
	if err := store.Apply(ctx, message(reading), reading); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("telemetry duplicate=%v", err)
	}
	if count := dbCount(t, db.runtime, tenant, `SELECT count(*) FROM sensor_reading_history WHERE tenant_id=$1`, tenant); count != 1 {
		t.Fatalf("sensor sample count=%d", count)
	}
	if count := dbCount(t, reader, tenant, `SELECT count(*) FROM read.latest_readings WHERE tenant_id=$1 AND device_id=$2 AND co2_ppm=450 AND grain_moisture_percent=13.5`, tenant, device); count != 1 {
		t.Fatalf("latest v2 reading count=%d", count)
	}
	if count := dbCount(t, reader, tenant, `SELECT count(*) FROM read.current_cable_sensors WHERE tenant_id=$1 AND cable_id=$2 AND label='Upper sensor'`, tenant, cable); count != 1 {
		t.Fatalf("current cable sensor count=%d", count)
	}
	if count := dbCount(t, reader, tenant, `SELECT count(*) FROM read.risk_assessments WHERE tenant_id=$1 AND assessment_id=$2 AND policy_provenance->>'source'='task5-live'`, tenant, assessmentID); count != 1 {
		t.Fatalf("assessment provenance count=%d", count)
	}
	if count := dbCount(t, db.runtime, tenant, `SELECT count(*) FROM risk_policy_versions WHERE tenant_id=$1 AND policy_id=$2 AND policy_version=1 AND effective_to=$3::timestamptz`, tenant, policyID, successorFrom); count != 1 {
		t.Fatalf("explicit policy supersedes closure count=%d", count)
	}
	if count := dbCount(t, db.runtime, tenant, `SELECT count(*) FROM site_views WHERE tenant_id=$1 AND site_id=$2 AND name='Current site' AND site_version=2`, tenant, site); count != 1 {
		t.Fatalf("stale site overwrote current version: %d", count)
	}

	want, err := referenceFoldAt(bodies, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err := WithTenant(ctx, db.runtime, tenant, func(ctx context.Context, tx pgx.Tx) error {
		got, err := readReferenceStateAt(ctx, tx, tenant, now.Add(-24*time.Hour))
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(want, got) {
			return fmt.Errorf("live projection differs from canonical fold: expected=%+v actual=%+v", want, got)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
