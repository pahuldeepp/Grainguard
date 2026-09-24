-- Telemetry write model. Design: docs/FIRST_VERTICAL_SLICE.md section 4.
-- Every tenant table has forced row-level security on app.tenant_id; the runtime role
-- telemetry_app is not the owner and cannot bypass it.

CREATE TABLE device_bindings (
  tenant_id         uuid        NOT NULL,
  device_id         uuid        NOT NULL,
  site_id           uuid        NOT NULL,
  bin_id            uuid,
  inventory_version bigint      NOT NULL CHECK (inventory_version > 0),
  status            text        NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
  applied_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, device_id)
);

CREATE TABLE device_streams (
  tenant_id    uuid   NOT NULL,
  device_id    uuid   NOT NULL,
  last_version bigint NOT NULL DEFAULT 0 CHECK (last_version >= 0),
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES device_bindings (tenant_id, device_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE readings (
  tenant_id                 uuid             NOT NULL,
  reading_id                uuid             NOT NULL,
  device_id                 uuid             NOT NULL,
  stream_version            bigint           NOT NULL CHECK (stream_version > 0),
  source_message_id         text             NOT NULL CHECK (length(source_message_id) BETWEEN 1 AND 200),
  site_id                   uuid             NOT NULL,
  bin_id                    uuid,
  binding_version           bigint           NOT NULL CHECK (binding_version > 0),
  observed_at               timestamptz      NOT NULL,
  received_at               timestamptz      NOT NULL,
  temperature_c             double precision,
  relative_humidity_percent double precision,
  PRIMARY KEY (tenant_id, reading_id),
  UNIQUE (tenant_id, device_id, source_message_id),
  UNIQUE (tenant_id, device_id, stream_version),
  FOREIGN KEY (tenant_id, device_id) REFERENCES device_bindings (tenant_id, device_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (temperature_c IS NOT NULL OR relative_humidity_percent IS NOT NULL),
  CHECK (temperature_c IS NULL OR temperature_c BETWEEN -80 AND 120),
  CHECK (relative_humidity_percent IS NULL OR relative_humidity_percent BETWEEN 0 AND 100)
);

CREATE TABLE ingest_receipts (
  tenant_id          uuid        NOT NULL,
  device_id          uuid        NOT NULL,
  source_message_id  text        NOT NULL,
  command_id         uuid        NOT NULL,
  reading_id         uuid        NOT NULL,
  event_id           uuid        NOT NULL,
  normalized_request jsonb       NOT NULL,
  response_body      jsonb       NOT NULL,
  accepted_at        timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, source_message_id),
  FOREIGN KEY (tenant_id, reading_id) REFERENCES readings (tenant_id, reading_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE outbox_events (
  event_id          uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL,
  aggregate_type    text        NOT NULL,
  aggregate_id      uuid        NOT NULL,
  aggregate_version bigint      NOT NULL CHECK (aggregate_version > 0),
  event_type        text        NOT NULL,
  schema_version    integer     NOT NULL CHECK (schema_version > 0),
  occurred_at       timestamptz NOT NULL,
  correlation_id    uuid        NOT NULL,
  causation_id      uuid        NOT NULL,
  traceparent       text        NOT NULL,
  payload           jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version)
);

CREATE TABLE audit_events (
  audit_id      uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  actor_type    text        NOT NULL,
  actor_id      text        NOT NULL,
  action        text        NOT NULL,
  resource_type text        NOT NULL,
  resource_id   uuid        NOT NULL,
  command_id    uuid        NOT NULL,
  event_id      uuid,
  outcome       text        NOT NULL CHECK (outcome IN ('succeeded', 'rejected')),
  occurred_at   timestamptz NOT NULL
);
CREATE INDEX audit_events_resource_idx ON audit_events (tenant_id, resource_type, resource_id);

CREATE TABLE consumer_inbox (
  consumer_name text        NOT NULL,
  tenant_id     uuid        NOT NULL,
  event_id      uuid        NOT NULL,
  event         jsonb       NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_name, tenant_id, event_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['device_bindings','device_streams','readings','ingest_receipts','outbox_events','audit_events','consumer_inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- Runtime privileges: no DELETE anywhere; identity columns are never updatable;
-- readings, receipts, outbox, audit and inbox are append-only.
GRANT SELECT, INSERT ON device_bindings TO telemetry_app;
GRANT UPDATE (site_id, bin_id, inventory_version, status, applied_at) ON device_bindings TO telemetry_app;
GRANT SELECT, INSERT ON device_streams TO telemetry_app;
GRANT UPDATE (last_version) ON device_streams TO telemetry_app;
GRANT SELECT, INSERT ON readings, ingest_receipts, consumer_inbox TO telemetry_app;
GRANT INSERT ON outbox_events, audit_events TO telemetry_app;
