package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// feedAge makes the local entitlement feed look like it was last verified ago
// seconds ago on every partition (ADR-0022).
func feedAge(t *testing.T, admin *pgx.Conn, ago int) {
	t.Helper()
	if _, err := admin.Exec(context.Background(), `INSERT INTO entitlement_feed_health(partition_id,verified_at)
 VALUES (0, now() - make_interval(secs => $1)), (1, now() - make_interval(secs => $1))
 ON CONFLICT (partition_id) DO UPDATE SET verified_at = excluded.verified_at`, ago); err != nil {
		t.Fatal(err)
	}
}

func TestENT07IngestQuotaThrottleAndNoAcceptedReadingDrop(t *testing.T) {
	f := ingSetup(t)
	admin := adminConn(t, ingTelemetryDB)
	feedAge(t, admin, 0)
	_, err := fixtureAdminExec(t, admin, f.tenant, `INSERT INTO tenant_entitlements
 (tenant_id,plan_key,plan_version,limits,features,source_version)
 VALUES($1,'standard',2,'{"ingest.readings_per_month":1}'::jsonb,'{}'::jsonb,1)`, f.tenant)
	if err != nil {
		t.Fatal(err)
	}
	first, err := f.ingest("quota-1", `,"temperature_c":4`)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.ingest("quota-2", `,"temperature_c":4`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.ingest("quota-3", `,"temperature_c":4`)
	var reject *Rejection
	if !errors.As(err, &reject) || reject.Reason != ReasonEntitlementVolume || reject.Status != 429 {
		t.Fatalf("want stable 429, got %v", err)
	}
	retried, err := f.ingest("quota-1", `,"temperature_c":4`)
	if err != nil || retried.ReadingID != first.ReadingID {
		t.Fatalf("accepted retry %+v %v", retried, err)
	}
	if second.ReadingID == first.ReadingID {
		t.Fatal("two accepted readings must be distinct")
	}
	if got := f.count("readings"); got != 2 {
		t.Fatalf("accepted readings count %d", got)
	}
	var accepted int
	period := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	if err := admin.QueryRow(context.Background(), `SELECT accepted FROM ingest_quota_usage WHERE tenant_id=$1 AND period_start=$2`, f.tenant, period).Scan(&accepted); err != nil || accepted != 2 {
		t.Fatalf("meter %d %v", accepted, err)
	}
}

func TestENT10PaidPlanAppliedAnHourAgoStillHonored(t *testing.T) {
	f := ingSetup(t)
	admin := adminConn(t, ingTelemetryDB)
	feedAge(t, admin, 0)
	_, err := fixtureAdminExec(t, admin, f.tenant, `INSERT INTO tenant_entitlements
 (tenant_id,plan_key,plan_version,limits,features,source_version,applied_at)
 VALUES($1,'standard',2,'{"ingest.readings_per_month":1}'::jsonb,'{}'::jsonb,1,now()-interval '1 hour')`, f.tenant)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"old-plan-1", "old-plan-2"} {
		if _, err := f.ingest(key, `,"temperature_c":4`); err != nil {
			t.Fatal(err)
		}
	}
	_, err = f.ingest("old-plan-3", `,"temperature_c":4`)
	var reject *Rejection
	if !errors.As(err, &reject) || reject.Reason != ReasonEntitlementVolume {
		t.Fatalf("the one-hour-old plan limit must still apply, got %v", err)
	}
}

func TestENT11StaleFeedFailsClosedToFreeDefaultsAndRecoversOnHeartbeat(t *testing.T) {
	f := ingSetup(t)
	admin := adminConn(t, ingTelemetryDB)
	_, err := fixtureAdminExec(t, admin, f.tenant, `INSERT INTO tenant_entitlements
 (tenant_id,plan_key,plan_version,limits,features,source_version)
 VALUES($1,'standard',2,'{"ingest.readings_per_month":1}'::jsonb,'{}'::jsonb,1)`, f.tenant)
	if err != nil {
		t.Fatal(err)
	}
	feedAge(t, admin, 3600)
	for _, key := range []string{"stale-1", "stale-2", "stale-3"} {
		if _, err := f.ingest(key, `,"temperature_c":4`); err != nil {
			t.Fatalf("stale feed must use the free 100000 default: %v", err)
		}
	}
	if err := applyEntitlementHeartbeat(context.Background(), admin, 0, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := applyEntitlementHeartbeat(context.Background(), admin, 1, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ingest("stale-4", `,"temperature_c":4`); err == nil {
		t.Fatal("healthy feed must restore the paid limit of 1 (grace 2), 3 readings already counted")
	}
}

func TestENT12HeartbeatIsMonotonicAndTouchesNoTenantRow(t *testing.T) {
	f := ingSetup(t)
	admin := adminConn(t, ingTelemetryDB)
	_, err := fixtureAdminExec(t, admin, f.tenant, `INSERT INTO tenant_entitlements
 (tenant_id,plan_key,plan_version,limits,features,source_version,applied_at)
 VALUES($1,'standard',2,'{"ingest.readings_per_month":7}'::jsonb,'{}'::jsonb,5,now()-interval '2 hours')`, f.tenant)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, at := range []time.Time{now, now.Add(-time.Hour), now.Add(time.Hour)} {
		if err := applyEntitlementHeartbeat(context.Background(), admin, 9, at); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), `DELETE FROM entitlement_feed_health WHERE partition_id=9`)
	}()
	var verifiedAgo float64
	if err := admin.QueryRow(context.Background(), `SELECT extract(epoch FROM now()-verified_at) FROM entitlement_feed_health WHERE partition_id=9`).Scan(&verifiedAgo); err != nil || verifiedAgo < -1 || verifiedAgo > 60 {
		t.Fatalf("heartbeat regressed or ran ahead of the clock: %v %v", verifiedAgo, err)
	}
	var version int64
	var appliedAgo float64
	if err := admin.QueryRow(context.Background(), `SELECT source_version, extract(epoch FROM now()-applied_at) FROM tenant_entitlements WHERE tenant_id=$1`, f.tenant).Scan(&version, &appliedAgo); err != nil || version != 5 || appliedAgo < 7000 {
		t.Fatalf("heartbeat must not rewrite plan rows: %d %v %v", version, appliedAgo, err)
	}
}

func TestParseHeartbeat(t *testing.T) {
	at, ok, err := parseHeartbeat([]byte(`{"event_type":"entitlements.heartbeat","emitted_at":"2026-09-25T00:00:00Z"}`))
	if err != nil || !ok || at.Year() != 2026 {
		t.Fatalf("valid heartbeat %v %v %v", at, ok, err)
	}
	if _, ok, err := parseHeartbeat([]byte(`{"event_type":"entitlements.changed"}`)); ok || err != nil {
		t.Fatal("plan events are not heartbeats")
	}
	if _, _, err := parseHeartbeat([]byte(`{"event_type":"entitlements.heartbeat","emitted_at":"x"}`)); err == nil {
		t.Fatal("malformed heartbeat accepted")
	}
}
