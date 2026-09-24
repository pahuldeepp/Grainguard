package main

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
)

// PromotionProof is produced by an external verifier that reads the canonical
// topics independently of the shadow inbox. A proof is valid only for the
// frontier it captured; the verifier must recheck it under the promotion lock.
type PromotionProof struct {
	AllTenantsReplayed      bool
	StableCommonFrontier    bool
	LiveShadowEqual         bool
	CanonicalReferenceEqual bool
	ZeroLag                 bool
	PostSwapConsumerReady   bool
}

type PromotionVerifier func(context.Context, pgx.Tx, string) (PromotionProof, error)

var promotionViews = []string{"device_views", "device_latest", "reading_history", "stream_gaps"}
var promotionIdentifier = regexp.MustCompile(`^read_v[1-9][0-9]{0,8}$`)

// PromoteReadViews serializes promotions and changes all reader routes atomically.
// The verifier runs in the same transaction after the advisory lock is acquired.
// Callers must supply a verifier that pins and validates the canonical frontier;
// nil and incomplete proofs are rejected. This function does not create tables.
func PromoteReadViews(ctx context.Context, db interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}, schema string, verify PromotionVerifier) error {
	if !promotionIdentifier.MatchString(schema) {
		return ErrInvalidProjectionSchema
	}
	if verify == nil {
		return errors.New("promotion verifier unavailable")
	}
	tx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7240513)"); err != nil {
		return err
	}
	if _, err = activeReadSchema(ctx, tx); err != nil {
		return fmt.Errorf("resolve active read route: %w", err)
	}
	proof, err := verify(ctx, tx, schema)
	if err != nil {
		return fmt.Errorf("promotion verification failed: %w", err)
	}
	if !proof.AllTenantsReplayed || !proof.StableCommonFrontier || !proof.LiveShadowEqual || !proof.CanonicalReferenceEqual || !proof.ZeroLag || !proof.PostSwapConsumerReady {
		return errors.New("promotion verification incomplete or lagging")
	}
	for _, name := range promotionViews {
		// CREATE OR REPLACE preserves grants on the read view. It also retains the
		// security options set by migration 000004; set them explicitly here.
		q := fmt.Sprintf("CREATE OR REPLACE VIEW read.%s WITH (security_invoker=true, security_barrier=true) AS SELECT * FROM %s.%s", name, schema, name)
		if _, err = tx.Exec(ctx, q); err != nil {
			return fmt.Errorf("replace read.%s: %w", name, err)
		}
	}
	if _, err = tx.Exec(ctx, "GRANT USAGE ON SCHEMA "+schema+" TO read_query"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "GRANT SELECT ON "+schema+".device_views, "+schema+".device_latest, "+schema+".reading_history, "+schema+".stream_gaps TO read_query"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "GRANT SELECT(tenant_id,event_id,consumer_name,event) ON "+schema+".consumer_inbox TO read_query"); err != nil {
		return err
	}
	latest := fmt.Sprintf(`CREATE OR REPLACE VIEW read.latest_readings WITH (security_invoker=true, security_barrier=true) AS
 SELECT l.tenant_id, l.device_id, l.reading_id, l.event_id,
        (i.event->'payload'->>'observed_at')::timestamptz AS observed_at,
        (i.event->'payload'->>'received_at')::timestamptz AS received_at,
        (i.event->'payload'->'measurements'->>'temperature_c')::double precision AS temperature_c,
        (i.event->'payload'->'measurements'->>'relative_humidity_percent')::double precision AS relative_humidity_percent,
        COALESCE(h.inventory_enrichment, 'source') AS inventory_enrichment
 FROM read.device_latest AS l
 JOIN %s.consumer_inbox AS i ON i.tenant_id=l.tenant_id AND i.event_id=l.event_id
 LEFT JOIN read.reading_history AS h ON h.tenant_id=l.tenant_id
   AND h.device_id=l.device_id AND h.reading_id=l.reading_id
 WHERE i.consumer_name='projection-builder'
   AND i.event->>'event_type'='telemetry.recorded'
   AND i.event->'payload'->>'device_id'=l.device_id::text
   AND i.event->'payload'->>'reading_id'=l.reading_id::text`, schema)
	if _, err = tx.Exec(ctx, latest); err != nil {
		return fmt.Errorf("replace read.latest_readings: %w", err)
	}
	return tx.Commit(ctx)
}
