-- Stage 06a: risk-engine write model. Forward-only (review O5): a failed deploy is
-- recovered by a new forward migration, never by editing an applied file (the runner
-- rejects a changed checksum). Executed by risk_migrator, the database owner.
-- Runtime role risk_app never owns objects, has NOBYPASSRLS and has no DELETE grant.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Idempotency ledger, append-only. Concurrency: the primary key alone. Racing deliveries
-- use INSERT ... ON CONFLICT DO NOTHING; the loser waits for the winner's commit, then
-- compares event_sha256 (same identity with a different payload is quarantined).
CREATE TABLE consumer_inbox (
  consumer_name    text        NOT NULL CHECK (consumer_name ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  tenant_id        uuid        NOT NULL,
  event_id         uuid        NOT NULL,
  event_type       text        NOT NULL,
  source_topic     text        NOT NULL,
  source_partition integer     NOT NULL CHECK (source_partition >= 0),
  source_offset    bigint      NOT NULL CHECK (source_offset >= 0),
  event_sha256     text        NOT NULL CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  event            jsonb       NOT NULL,
  processed_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_name, tenant_id, event_id)
);

-- Local copy of inventory device bindings. Concurrency: pessimistic row read
-- (SELECT ... FOR UPDATE) plus a monotone inventory_version guard enforced by the
-- trigger below, so an older or replayed inventory event can never regress state.
CREATE TABLE device_bindings (
  tenant_id         uuid        NOT NULL,
  device_id         uuid        NOT NULL,
  site_id           uuid,
  bin_id            uuid,
  status            text,
  inventory_version bigint      NOT NULL CHECK (inventory_version > 0),
  binding_version   bigint      NOT NULL CHECK (binding_version > 0),
  source_event_id   uuid        NOT NULL,
  applied_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, device_id)
);

CREATE FUNCTION device_bindings_monotone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.device_id <> OLD.device_id
     OR NEW.inventory_version <= OLD.inventory_version
     OR NEW.binding_version < OLD.binding_version THEN
    RAISE EXCEPTION 'device binding versions must increase' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER device_bindings_monotone BEFORE UPDATE ON device_bindings
  FOR EACH ROW EXECUTE FUNCTION device_bindings_monotone();

-- Effective bin occupancy history from greenguard.inventory.lot.v1, half-open
-- [effective_from, effective_to) like device-service bin_occupancies.
-- Concurrency: pessimistic per-bin transaction advisory lock taken by the consumer
-- before reading the bin's versions; the exclusion constraint, primary key and the
-- triggers below are the database backstop. History is immutable except that an
-- open interval may be closed exactly once.
CREATE TABLE bin_lot_intervals (
  tenant_id         uuid        NOT NULL,
  bin_id            uuid        NOT NULL,
  occupancy_version bigint      NOT NULL CHECK (occupancy_version > 0),
  site_id           uuid        NOT NULL,
  lot_id            uuid        NOT NULL,
  grain_type        text        NOT NULL CHECK (grain_type ~ '^[a-z][a-z0-9_-]{0,31}$'),
  variety           text        CHECK (variety IS NULL OR length(variety) BETWEEN 1 AND 100),
  effective_from    timestamptz NOT NULL,
  effective_to      timestamptz,
  previous_lot_id   uuid,
  source_event_id   uuid        NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, bin_id, occupancy_version),
  CONSTRAINT bin_lot_intervals_ordered CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT bin_lot_intervals_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, bin_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)
);

CREATE FUNCTION bin_lot_intervals_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bin_lot_intervals
              WHERE tenant_id = NEW.tenant_id AND bin_id = NEW.bin_id
                AND occupancy_version >= NEW.occupancy_version) THEN
    RAISE EXCEPTION 'occupancy_version must increase per bin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bin_lot_intervals_insert_guard BEFORE INSERT ON bin_lot_intervals
  FOR EACH ROW EXECUTE FUNCTION bin_lot_intervals_insert_guard();

CREATE FUNCTION bin_lot_intervals_close_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL
     OR (NEW.tenant_id, NEW.bin_id, NEW.occupancy_version, NEW.site_id, NEW.lot_id,
         NEW.grain_type, NEW.variety, NEW.effective_from, NEW.previous_lot_id,
         NEW.source_event_id, NEW.recorded_at)
        IS DISTINCT FROM
        (OLD.tenant_id, OLD.bin_id, OLD.occupancy_version, OLD.site_id, OLD.lot_id,
         OLD.grain_type, OLD.variety, OLD.effective_from, OLD.previous_lot_id,
         OLD.source_event_id, OLD.recorded_at) THEN
    RAISE EXCEPTION 'lot interval history is immutable; only an open interval may be closed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bin_lot_intervals_close_only BEFORE UPDATE ON bin_lot_intervals
  FOR EACH ROW EXECUTE FUNCTION bin_lot_intervals_close_only();

-- Per-device risk event stream version for outbox aggregate_version.
-- Concurrency: pessimistic; INSERT ... ON CONFLICT DO UPDATE holds the row lock
-- until commit, so concurrent assessments for one device serialise.
CREATE TABLE device_risk_streams (
  tenant_id    uuid   NOT NULL,
  device_id    uuid   NOT NULL,
  last_version bigint NOT NULL CHECK (last_version > 0),
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES device_bindings (tenant_id, device_id)
);

-- INSERT-only assessment ledger. Concurrency: none needed; the unique identity
-- (tenant, source event, lot, policy version) makes a racing duplicate fail and roll
-- back, and redelivery is resolved earlier by the inbox.
CREATE TABLE risk_assessments (
  assessment_id     uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL,
  source_event_id   uuid        NOT NULL,
  reading_id        uuid        NOT NULL,
  device_id         uuid        NOT NULL,
  bin_id            uuid        NOT NULL,
  lot_id            uuid        NOT NULL,
  occupancy_version bigint      NOT NULL,
  grain_type        text        NOT NULL,
  policy_version    bigint      NOT NULL CHECK (policy_version > 0),
  score             smallint    CHECK (score BETWEEN 0 AND 100),
  severity          text        NOT NULL CHECK (severity IN ('normal', 'warning', 'critical', 'insufficient_data')),
  alert_eligible    boolean     NOT NULL,
  reasons           jsonb       NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  observed_at       timestamptz NOT NULL,
  event_id          uuid        NOT NULL UNIQUE,
  aggregate_version bigint      NOT NULL CHECK (aggregate_version > 0),
  correlation_id    uuid        NOT NULL,
  causation_id      uuid        NOT NULL CHECK (causation_id = source_event_id),
  traceparent       text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, source_event_id, lot_id, policy_version),
  FOREIGN KEY (tenant_id, bin_id, occupancy_version)
    REFERENCES bin_lot_intervals (tenant_id, bin_id, occupancy_version),
  FOREIGN KEY (tenant_id, device_id) REFERENCES device_bindings (tenant_id, device_id)
);
CREATE INDEX risk_assessments_bin_lot_time_idx
  ON risk_assessments (tenant_id, bin_id, lot_id, observed_at);

-- Transactional outbox, append-only, same shape as the other owners' outbox tables.
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

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consumer_inbox','device_bindings','bin_lot_intervals','device_risk_streams','risk_assessments','outbox_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- Bounded quarantine sample (not tenant data: no tenant, device or payload is kept,
-- only the Kafka coordinates, a stable reason and a payload digest). Slot is
-- source_offset % 1000, so storage is bounded per topic partition; the full record is
-- replayed from Kafka by its coordinates while retained. Overwrite-only.
CREATE TABLE quarantine_samples (
  consumer_name    text        NOT NULL,
  source_topic     text        NOT NULL,
  source_partition integer     NOT NULL CHECK (source_partition >= 0),
  slot             smallint    NOT NULL CHECK (slot BETWEEN 0 AND 999),
  source_offset    bigint      NOT NULL CHECK (source_offset >= 0),
  reason           text        NOT NULL CHECK (reason ~ '^[a-z][a-z_]{0,63}$'),
  payload_sha256   text        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  quarantined_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_name, source_topic, source_partition, slot)
);

GRANT SELECT, INSERT ON consumer_inbox, device_bindings, bin_lot_intervals,
  device_risk_streams, risk_assessments, quarantine_samples TO risk_app;
GRANT UPDATE (site_id, bin_id, status, inventory_version, binding_version, source_event_id, applied_at)
  ON device_bindings TO risk_app;
GRANT UPDATE (effective_to) ON bin_lot_intervals TO risk_app;
GRANT UPDATE (last_version) ON device_risk_streams TO risk_app;
GRANT UPDATE (source_offset, reason, payload_sha256, quarantined_at) ON quarantine_samples TO risk_app;
GRANT INSERT ON outbox_events TO risk_app;

-- R1/H2: CDC snapshot access across tenants is limited to the immutable outbox,
-- exactly as in greenguard_telemetry. The connector itself is a later task.
GRANT USAGE ON SCHEMA public TO cdc_reader;
GRANT SELECT ON TABLE public.outbox_events TO cdc_reader;
CREATE POLICY cdc_outbox_snapshot ON public.outbox_events FOR SELECT TO cdc_reader USING (true);
CREATE PUBLICATION greenguard_outbox FOR TABLE public.outbox_events WITH (publish = 'insert');
