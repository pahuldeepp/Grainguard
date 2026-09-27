package main

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

// consumeIngestQuota runs after the idempotency receipt lookup and before the
// reading insert, inside that same transaction. Rejected requests commit neither.
// The tenant-period row lock serializes concurrent devices at the grace boundary.
func consumeIngestQuota(ctx context.Context, tx pgx.Tx, tenantID string, now time.Time) error {
	var limit int64
	err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT CASE WHEN entitlement_feed_fresh()
 AND (limits->>'ingest.readings_per_month') ~ '^[0-9]+$'
 THEN LEAST((limits->>'ingest.readings_per_month')::numeric, 1000000000)::bigint END
 FROM tenant_entitlements WHERE tenant_id=$1), 100000)`, tenantID).Scan(&limit)
	if err != nil {
		return fmt.Errorf("read ingest entitlement: %w", err)
	}
	grace := int64(math.Ceil(float64(limit) * 1.1))
	period := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	var accepted int64
	err = tx.QueryRow(ctx, `INSERT INTO ingest_quota_usage (tenant_id, period_start, accepted)
 VALUES ($1,$2,1) ON CONFLICT (tenant_id, period_start)
 DO UPDATE SET accepted=ingest_quota_usage.accepted+1
 WHERE ingest_quota_usage.accepted < $3 RETURNING accepted`, tenantID, period, grace).Scan(&accepted)
	if err == pgx.ErrNoRows {
		return newRejection(ReasonEntitlementVolume, 429, "Monthly reading allowance and grace exhausted; retry next period")
	}
	if err != nil {
		return fmt.Errorf("record ingest quota: %w", err)
	}
	return nil
}
