package main

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
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

var promotionViews = []string{"device_views", "device_latest", "reading_history", "stream_gaps", "site_views", "bin_views", "cable_layout_versions", "cable_layout_sensors", "sensor_reading_history", "risk_policy_versions", "risk_assessments"}
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
	if _, err = tx.Exec(ctx, "GRANT SELECT ON "+schema+".device_views, "+schema+".device_latest, "+schema+".reading_history, "+schema+".stream_gaps, "+schema+".site_views, "+schema+".bin_views, "+schema+".cable_layout_versions, "+schema+".cable_layout_sensors, "+schema+".sensor_reading_history, "+schema+".risk_policy_versions, "+schema+".risk_assessments TO read_query"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "GRANT SELECT(tenant_id,event_id,consumer_name,event,processed_at) ON "+schema+".consumer_inbox TO read_query"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "DROP VIEW read.latest_readings"); err != nil {
		return fmt.Errorf("drop read.latest_readings: %w", err)
	}
	latest := fmt.Sprintf(`CREATE VIEW read.latest_readings WITH (security_invoker=true, security_barrier=true) AS
 SELECT l.tenant_id, l.device_id, l.reading_id, l.event_id,
        (i.event->'payload'->>'site_id')::uuid AS site_id,
        (i.event->'payload'->>'bin_id')::uuid AS bin_id,
        (i.event->'payload'->>'observed_at')::timestamptz AS observed_at,
        (i.event->'payload'->>'received_at')::timestamptz AS received_at,
        COALESCE(h.projected_at,i.processed_at) AS projected_at,
        (i.event->>'schema_version')::smallint AS schema_version,
		COALESCE(h.temperature_c,(i.event->'payload'->'measurements'->>'temperature_c')::double precision) AS temperature_c,
		COALESCE(h.relative_humidity_percent,(i.event->'payload'->'measurements'->>'relative_humidity_percent')::double precision) AS relative_humidity_percent,
		COALESCE(h.co2_ppm,(i.event->'payload'->'measurements'->>'co2_ppm')::double precision) AS co2_ppm,
		COALESCE(h.grain_moisture_percent,(i.event->'payload'->'measurements'->>'grain_moisture_percent')::double precision) AS grain_moisture_percent,
        i.event->'payload'->'measurement_units' AS measurement_units,
        COALESCE(h.inventory_enrichment, 'source') AS inventory_enrichment,
        GREATEST(0,extract(epoch FROM clock_timestamp()-(i.event->'payload'->>'observed_at')::timestamptz)) AS age_seconds,
        NULL::double precision AS stale_after_seconds,
        NULL::boolean AS stale
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
	for _, view := range []string{
		"CREATE OR REPLACE VIEW read.site_views WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM " + schema + ".site_views",
		"CREATE OR REPLACE VIEW read.bin_views WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM " + schema + ".bin_views",
		"CREATE OR REPLACE VIEW read.cable_layout_versions WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM " + schema + ".cable_layout_versions",
		"CREATE OR REPLACE VIEW read.cable_layout_sensors WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM " + schema + ".cable_layout_sensors",
		"CREATE OR REPLACE VIEW read.sensor_reading_history WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM " + schema + ".sensor_reading_history",
		"CREATE OR REPLACE VIEW read.risk_policy_versions WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM " + schema + ".risk_policy_versions",
		"CREATE OR REPLACE VIEW read.risk_assessments WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM " + schema + ".risk_assessments",
		"CREATE OR REPLACE VIEW read.current_cables WITH (security_invoker=true,security_barrier=true) AS SELECT DISTINCT ON (tenant_id,cable_id) tenant_id,cable_id,device_id,bin_id,cable_version,operation,event_id,occurred_at FROM read.cable_layout_versions ORDER BY tenant_id,cable_id,cable_version DESC",
		"CREATE OR REPLACE VIEW read.current_cable_sensors WITH (security_invoker=true,security_barrier=true) AS SELECT s.tenant_id,s.cable_id,s.sensor_id,s.cable_version,s.position,s.label,s.depth_m FROM read.current_cables c JOIN read.cable_layout_sensors s ON s.tenant_id=c.tenant_id AND s.cable_id=c.cable_id AND s.cable_version=c.cable_version WHERE c.operation='upsert'",
		"CREATE OR REPLACE VIEW read.bin_metric_history WITH (security_invoker=true,security_barrier=true) AS SELECT tenant_id,device_id,reading_id,event_id,site_id,bin_id,observed_at,received_at,projected_at,stream_version,'temperature_c'::text AS metric,'Cel'::text AS unit,temperature_c AS value FROM read.reading_history WHERE temperature_c IS NOT NULL UNION ALL SELECT tenant_id,device_id,reading_id,event_id,site_id,bin_id,observed_at,received_at,projected_at,stream_version,'relative_humidity_percent','%',relative_humidity_percent FROM read.reading_history WHERE relative_humidity_percent IS NOT NULL UNION ALL SELECT tenant_id,device_id,reading_id,event_id,site_id,bin_id,observed_at,received_at,projected_at,stream_version,'co2_ppm','ppm',co2_ppm FROM read.reading_history WHERE co2_ppm IS NOT NULL UNION ALL SELECT tenant_id,device_id,reading_id,event_id,site_id,bin_id,observed_at,received_at,projected_at,stream_version,'grain_moisture_percent','%',grain_moisture_percent FROM read.reading_history WHERE grain_moisture_percent IS NOT NULL",
		"CREATE OR REPLACE VIEW read.sensor_readings WITH (security_invoker=true,security_barrier=true) AS SELECT r.tenant_id,r.device_id,r.reading_id,r.bin_id,r.observed_at,r.received_at,r.stream_version,r.cable_id,r.layout_version,r.sensor_id,r.position,layout.label,r.depth_m,r.metric,r.value,r.unit FROM read.sensor_reading_history r LEFT JOIN read.cable_layout_sensors layout ON layout.tenant_id=r.tenant_id AND layout.cable_id=r.cable_id AND layout.cable_version=r.layout_version AND layout.sensor_id=r.sensor_id",
		"CREATE OR REPLACE VIEW read.latest_sensor_readings WITH (security_invoker=true,security_barrier=true) AS SELECT l.tenant_id,l.device_id,l.reading_id,(i.event->'payload'->>'site_id')::uuid AS site_id,(i.event->'payload'->>'bin_id')::uuid AS bin_id,(i.event->'payload'->>'observed_at')::timestamptz AS observed_at,(i.event->'payload'->>'received_at')::timestamptz AS received_at,(s->>'sensor_id')::uuid AS sensor_id,(s->>'cable_id')::uuid AS cable_id,(s->>'layout_version')::bigint AS layout_version,(s->>'position')::integer AS position,(s->>'depth_m')::double precision AS depth_m,layout.label,s->>'metric' AS metric,(s->>'value')::double precision AS value,s->>'unit' AS unit FROM read.device_latest l JOIN " + schema + ".consumer_inbox i ON i.tenant_id=l.tenant_id AND i.event_id=l.event_id CROSS JOIN LATERAL jsonb_array_elements(COALESCE(i.event->'payload'->'sensor_observations','[]'::jsonb)) AS obs(s) LEFT JOIN read.cable_layout_sensors layout ON layout.tenant_id=l.tenant_id AND layout.cable_id=(s->>'cable_id')::uuid AND layout.cable_version=(s->>'layout_version')::bigint AND layout.sensor_id=(s->>'sensor_id')::uuid WHERE i.consumer_name='projection-builder' AND i.event->>'event_type'='telemetry.recorded' AND i.event->'payload'->>'device_id'=l.device_id::text AND i.event->'payload'->>'reading_id'=l.reading_id::text",
	} {
		if _, err := tx.Exec(ctx, view); err != nil {
			return fmt.Errorf("replace domain read route: %w", err)
		}
	}
	if _, err = tx.Exec(ctx, "GRANT SELECT ON read.site_views,read.bin_views,read.cable_layout_versions,read.cable_layout_sensors,read.sensor_reading_history,read.risk_policy_versions,read.risk_assessments,read.current_cables,read.current_cable_sensors,read.bin_metric_history,read.sensor_readings,read.latest_sensor_readings,read.latest_readings TO read_query"); err != nil {
		return err
	}
	if err = emitPromotionEpoch(ctx, tx, schema); err != nil {
		return fmt.Errorf("record promotion invalidation: %w", err)
	}
	return tx.Commit(ctx)
}

// emitPromotionEpoch inserts one synthetic source receipt and notification in
// the same transaction as the view swap. The trigger writes the canonical CDC
// outbox row. A global epoch avoids one write for each of millions of tenants.
func emitPromotionEpoch(ctx context.Context, tx pgx.Tx, schema string) error {
	eventID := uuid.NewString()
	traceID := strings.ReplaceAll(uuid.NewString(), "-", "")
	traceparent := "00-" + traceID + "-" + traceID[:16] + "-01"
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, infrastructureTenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO public.consumer_inbox
		(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event)
		VALUES ('promotion',$1,$2,'projection.promotion',0,0,
		jsonb_build_object('event_type','projection.promoted','aggregate_version','1',
		'correlation_id',$2::uuid,'traceparent',$3::text,'schema_name',$4::text))`, infrastructureTenant, eventID, traceparent, schema); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO public.projection_notifications
		(tenant_id,notification_id,resource_type,resource_id,event_id,purpose,consumer_name)
		VALUES ($1,$2,'device',$1,$2,'promotion_changed','promotion')`, infrastructureTenant, eventID)
	return err
}
