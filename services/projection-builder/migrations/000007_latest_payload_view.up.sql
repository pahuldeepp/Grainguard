-- Latest readings outlive the partitioned hot history. The inbox retains the
-- validated source event, while both join inputs enforce tenant RLS.
CREATE VIEW read.latest_readings WITH (security_invoker=true, security_barrier=true) AS
 SELECT l.tenant_id, l.device_id, l.reading_id, l.event_id,
        (i.event->'payload'->>'observed_at')::timestamptz AS observed_at,
        (i.event->'payload'->>'received_at')::timestamptz AS received_at,
        (i.event->'payload'->'measurements'->>'temperature_c')::double precision AS temperature_c,
        (i.event->'payload'->'measurements'->>'relative_humidity_percent')::double precision AS relative_humidity_percent,
        COALESCE(h.inventory_enrichment, 'source') AS inventory_enrichment
 FROM read.device_latest AS l
 JOIN public.consumer_inbox AS i ON i.tenant_id=l.tenant_id AND i.event_id=l.event_id
 LEFT JOIN read.reading_history AS h ON h.tenant_id=l.tenant_id
   AND h.device_id=l.device_id AND h.reading_id=l.reading_id
 WHERE i.consumer_name='projection-builder'
   AND i.event->>'event_type'='telemetry.recorded'
   AND i.event->'payload'->>'device_id'=l.device_id::text
   AND i.event->'payload'->>'reading_id'=l.reading_id::text;

GRANT SELECT(tenant_id,event_id,consumer_name,event) ON public.consumer_inbox TO read_query;
GRANT SELECT ON read.latest_readings TO read_query;
