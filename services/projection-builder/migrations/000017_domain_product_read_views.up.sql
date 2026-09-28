-- Stable invoker-security read views over the active projection. Promotion
-- replaces their source schema atomically alongside the original read views.
CREATE VIEW read.site_views WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM public.site_views;
CREATE VIEW read.bin_views WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM public.bin_views;
CREATE VIEW read.cable_layout_versions WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM public.cable_layout_versions;
CREATE VIEW read.cable_layout_sensors WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM public.cable_layout_sensors;
CREATE VIEW read.sensor_reading_history WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM public.sensor_reading_history;
CREATE VIEW read.risk_policy_versions WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM public.risk_policy_versions;
CREATE VIEW read.risk_assessments WITH (security_invoker=true,security_barrier=true) AS SELECT * FROM public.risk_assessments;
CREATE VIEW read.current_cables WITH (security_invoker=true,security_barrier=true) AS
 SELECT DISTINCT ON (tenant_id,cable_id) tenant_id,cable_id,device_id,bin_id,cable_version,operation,event_id,occurred_at
 FROM read.cable_layout_versions ORDER BY tenant_id,cable_id,cable_version DESC;
CREATE VIEW read.current_cable_sensors WITH (security_invoker=true,security_barrier=true) AS
 SELECT s.tenant_id,s.cable_id,s.sensor_id,s.cable_version,s.position,s.label,s.depth_m
 FROM read.current_cables c JOIN read.cable_layout_sensors s
   ON s.tenant_id=c.tenant_id AND s.cable_id=c.cable_id AND s.cable_version=c.cable_version
 WHERE c.operation='upsert';

-- The base read view predates additive v2 history columns. Refresh its expanded
-- column list before defining views that reference CO2 and grain moisture.
CREATE OR REPLACE VIEW read.reading_history WITH (security_invoker=true,security_barrier=true) AS
 SELECT * FROM public.reading_history;

-- Latest payloads are sourced from the validated inbox so they survive the hot
-- history cutoff. Projected_at and ages are real; stale is unknown until an
-- owner-approved freshness cadence is configured.
DROP VIEW read.latest_readings;
CREATE VIEW read.latest_readings WITH (security_invoker=true,security_barrier=true) AS
 SELECT l.tenant_id,l.device_id,l.reading_id,l.event_id,
        (i.event->'payload'->>'site_id')::uuid AS site_id,
        (i.event->'payload'->>'bin_id')::uuid AS bin_id,
        (i.event->'payload'->>'observed_at')::timestamptz AS observed_at,
        (i.event->'payload'->>'received_at')::timestamptz AS received_at,
        COALESCE(h.projected_at,i.processed_at) AS projected_at,
        (i.event->>'schema_version')::smallint AS schema_version,
        COALESCE(h.temperature_c,(i.event->'payload'->'measurements'->>'temperature_c')::double precision) AS temperature_c,
        COALESCE(h.relative_humidity_percent,(i.event->'payload'->'measurements'->>'relative_humidity_percent')::double precision) AS relative_humidity_percent,
        (i.event->'payload'->'measurements'->>'co2_ppm')::double precision AS co2_ppm,
        (i.event->'payload'->'measurements'->>'grain_moisture_percent')::double precision AS grain_moisture_percent,
        i.event->'payload'->'measurement_units' AS measurement_units,
        COALESCE(h.inventory_enrichment,'source') AS inventory_enrichment,
        GREATEST(0,extract(epoch FROM clock_timestamp()-(i.event->'payload'->>'observed_at')::timestamptz)) AS age_seconds,
        NULL::double precision AS stale_after_seconds,
        NULL::boolean AS stale
 FROM read.device_latest l
 JOIN public.consumer_inbox i ON i.tenant_id=l.tenant_id AND i.event_id=l.event_id
 LEFT JOIN read.reading_history h ON h.tenant_id=l.tenant_id AND h.device_id=l.device_id AND h.reading_id=l.reading_id
 WHERE i.consumer_name='projection-builder' AND i.event->>'event_type'='telemetry.recorded'
   AND i.event->'payload'->>'device_id'=l.device_id::text AND i.event->'payload'->>'reading_id'=l.reading_id::text;

CREATE VIEW read.bin_metric_history WITH (security_invoker=true,security_barrier=true) AS
 SELECT tenant_id,device_id,reading_id,event_id,site_id,bin_id,observed_at,received_at,projected_at,stream_version,
        'temperature_c'::text AS metric,'Cel'::text AS unit,temperature_c AS value FROM read.reading_history WHERE temperature_c IS NOT NULL
 UNION ALL
 SELECT tenant_id,device_id,reading_id,event_id,site_id,bin_id,observed_at,received_at,projected_at,stream_version,
        'relative_humidity_percent','%',relative_humidity_percent FROM read.reading_history WHERE relative_humidity_percent IS NOT NULL
 UNION ALL
 SELECT tenant_id,device_id,reading_id,event_id,site_id,bin_id,observed_at,received_at,projected_at,stream_version,
        'co2_ppm','ppm',co2_ppm FROM read.reading_history WHERE co2_ppm IS NOT NULL
 UNION ALL
 SELECT tenant_id,device_id,reading_id,event_id,site_id,bin_id,observed_at,received_at,projected_at,stream_version,
        'grain_moisture_percent','%',grain_moisture_percent FROM read.reading_history WHERE grain_moisture_percent IS NOT NULL;

CREATE VIEW read.sensor_readings WITH (security_invoker=true,security_barrier=true) AS
 SELECT r.tenant_id,r.device_id,r.reading_id,r.bin_id,r.observed_at,r.received_at,r.stream_version,
        r.cable_id,r.layout_version,r.sensor_id,r.position,layout.label,r.depth_m,r.metric,r.value,r.unit
 FROM read.sensor_reading_history r
 LEFT JOIN read.cable_layout_sensors layout ON layout.tenant_id=r.tenant_id AND layout.cable_id=r.cable_id
   AND layout.cable_version=r.layout_version AND layout.sensor_id=r.sensor_id;

-- For an expired/out-of-window latest reading, expand only the newest device
-- event from its bounded v2 payload. This keeps latest sensor measurements
-- available without inventing cold-history coverage.
CREATE VIEW read.latest_sensor_readings WITH (security_invoker=true,security_barrier=true) AS
 SELECT l.tenant_id,l.device_id,l.reading_id,(payload.p->>'site_id')::uuid AS site_id,(payload.p->>'bin_id')::uuid AS bin_id,
        (payload.p->>'observed_at')::timestamptz AS observed_at,(payload.p->>'received_at')::timestamptz AS received_at,
        (s->>'sensor_id')::uuid AS sensor_id,(s->>'cable_id')::uuid AS cable_id,
        (s->>'layout_version')::bigint AS layout_version,(s->>'position')::integer AS position,
        (s->>'depth_m')::double precision AS depth_m,layout.label,s->>'metric' AS metric,
        (s->>'value')::double precision AS value,s->>'unit' AS unit
 FROM read.device_latest l
 JOIN public.consumer_inbox i ON i.tenant_id=l.tenant_id AND i.event_id=l.event_id
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(i.event->'payload'->'sensor_observations','[]'::jsonb)) AS obs(s)
 CROSS JOIN LATERAL (SELECT i.event->'payload' AS p) payload
 LEFT JOIN read.cable_layout_sensors layout ON layout.tenant_id=l.tenant_id
   AND layout.cable_id=(s->>'cable_id')::uuid AND layout.cable_version=(s->>'layout_version')::bigint
   AND layout.sensor_id=(s->>'sensor_id')::uuid
 WHERE i.consumer_name='projection-builder' AND i.event->>'event_type'='telemetry.recorded'
   AND i.event->'payload'->>'device_id'=l.device_id::text AND i.event->'payload'->>'reading_id'=l.reading_id::text;

REVOKE ALL ON read.site_views,read.bin_views,read.cable_layout_versions,read.cable_layout_sensors,
 read.sensor_reading_history,read.risk_policy_versions,read.risk_assessments,read.current_cables,
 read.current_cable_sensors,read.bin_metric_history,read.sensor_readings,read.latest_sensor_readings FROM PUBLIC;
GRANT SELECT ON read.site_views,read.bin_views,read.cable_layout_versions,read.cable_layout_sensors,
 read.sensor_reading_history,read.risk_policy_versions,read.risk_assessments,read.current_cables,
 read.current_cable_sensors,read.bin_metric_history,read.sensor_readings,read.latest_sensor_readings,
 read.latest_readings TO read_query;
GRANT SELECT ON public.site_views,public.bin_views,public.cable_layout_versions,public.cable_layout_sensors,
 public.sensor_reading_history,public.risk_policy_versions,public.risk_assessments TO read_query;
GRANT SELECT(tenant_id,event_id,consumer_name,event,processed_at) ON public.consumer_inbox TO read_query;
