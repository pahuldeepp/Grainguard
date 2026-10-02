-- Initial local-only shadow schema for the I5 vertical slice.
-- Execute as the dedicated ml_migrator owner. Runtime ml_app is a separate
-- non-owner, NOBYPASSRLS login provisioned by environment IaC.

CREATE TABLE consumer_inbox (
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL,
    payload_sha256 char(64) NOT NULL,
    topic text NOT NULL,
    partition_id integer NOT NULL CHECK (partition_id >= 0),
    offset_id bigint NOT NULL CHECK (offset_id >= 0),
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, event_id),
    UNIQUE (topic, partition_id, offset_id)
);
CREATE INDEX consumer_inbox_tenant_processed_at_idx
    ON consumer_inbox (tenant_id, processed_at);

CREATE TABLE bin_window_state (
    tenant_id uuid NOT NULL,
    bin_id uuid NOT NULL,
    state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
    last_source_event_seq bigint NOT NULL CHECK (last_source_event_seq >= 0),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, bin_id)
);

CREATE TABLE ml_predictions (
    tenant_id uuid NOT NULL,
    prediction_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    window_end timestamptz NOT NULL,
    model_name text NOT NULL,
    model_version text NOT NULL,
    feature_set_version text NOT NULL,
    revision integer NOT NULL CHECK (revision >= 0),
    probability double precision NOT NULL CHECK (probability BETWEEN 0 AND 1),
    feature_digest char(64) NOT NULL,
    mode text NOT NULL CHECK (mode IN ('champion', 'canary')),
    status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, prediction_id),
    UNIQUE (tenant_id, subject_id, window_end, model_version, feature_set_version, revision)
);

CREATE TABLE ml_shadow_predictions (
    tenant_id uuid NOT NULL,
    prediction_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    window_end timestamptz NOT NULL,
    model_name text NOT NULL,
    model_version text NOT NULL,
    feature_set_version text NOT NULL,
    revision integer NOT NULL CHECK (revision >= 0),
    probability double precision NOT NULL CHECK (probability BETWEEN 0 AND 1),
    feature_digest char(64) NOT NULL,
    status text NOT NULL,
    data_origin text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, prediction_id),
    UNIQUE (tenant_id, subject_id, window_end, model_version, feature_set_version, revision)
);

CREATE TABLE ml_shadow_outbox (
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_at timestamptz,
    lease_token uuid,
    lease_until timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error text,
    PRIMARY KEY (tenant_id, event_id),
    CHECK (payload ?& ARRAY['event_id', 'tenant_id', 'event_type', 'aggregate_type', 'payload']
           AND payload->'event_id' = to_jsonb(event_id::text)
           AND payload->'tenant_id' = to_jsonb(tenant_id::text)
           AND payload->'event_type' = '"ml.prediction.shadowed"'::jsonb
           AND payload->'aggregate_type' = '"ml_prediction"'::jsonb
           AND jsonb_typeof(payload->'payload') = 'object'
           AND (payload->'payload') ?& ARRAY['mode', 'production_eligible', 'data_origin']
           AND payload->'payload'->'mode' = '"shadow"'::jsonb
           AND payload->'payload'->'production_eligible' = 'false'::jsonb
           AND payload->'payload'->'data_origin' = '"synthetic_grain_sim"'::jsonb),
    CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);

CREATE TABLE outbox_events (
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL,
    aggregate_id uuid NOT NULL,
    aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
    event_type text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    traceparent text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, event_id),
    UNIQUE (tenant_id, aggregate_id, aggregate_version),
    CONSTRAINT shadow_never_enters_outbox CHECK (
        payload->>'mode' IS DISTINCT FROM 'shadow'
        AND payload->'payload'->>'mode' IS DISTINCT FROM 'shadow'
    )
);

CREATE TABLE scoring_checkpoints (
    cell_id text NOT NULL,
    topic text NOT NULL,
    partition_id integer NOT NULL CHECK (partition_id >= 0),
    committed_offset bigint NOT NULL CHECK (committed_offset >= 0),
    scored_through_event_time timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (cell_id, topic, partition_id)
);

CREATE TABLE quarantine_samples (
    slot integer NOT NULL CHECK (slot BETWEEN 0 AND 999),
    topic text NOT NULL,
    partition_id integer NOT NULL CHECK (partition_id >= 0),
    offset_id bigint NOT NULL CHECK (offset_id >= 0),
    reason_code text NOT NULL,
    payload_sha256 char(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (topic, partition_id, slot)
);

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'consumer_inbox', 'bin_window_state', 'ml_predictions',
        'ml_shadow_predictions', 'ml_shadow_outbox', 'outbox_events'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING '
            '(tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
            'WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name
        );
    END LOOP;
END $$;

CREATE INDEX ml_shadow_predictions_tenant_window_idx
    ON ml_shadow_predictions (tenant_id, subject_id, window_end DESC);
CREATE INDEX ml_shadow_outbox_pending_idx
    ON ml_shadow_outbox (tenant_id, created_at)
    WHERE published_at IS NULL;
CREATE INDEX ml_shadow_outbox_published_retention_idx
    ON ml_shadow_outbox (tenant_id, created_at, event_id)
    WHERE published_at IS NOT NULL;
CREATE INDEX ml_predictions_tenant_window_idx
    ON ml_predictions (tenant_id, subject_id, window_end DESC);

COMMENT ON TABLE scoring_checkpoints IS 'Cell-level Kafka commit/watermark state; intentionally non-tenant per R27.';
COMMENT ON TABLE quarantine_samples IS 'Bounded digest-only quarantine metadata; never stores raw event payloads.';
COMMENT ON TABLE ml_shadow_predictions IS 'Synthetic-only shadow predictions; never consumed by production risk or alert flows. Rows older than 30 days are pruned only after the matching shadow event is published.';
COMMENT ON TABLE ml_shadow_outbox IS 'Tenant-scoped transactional outbox for the isolated shadow topic; published rows older than 30 days are pruned in bounded batches, while pending rows are retained.';
COMMENT ON TABLE consumer_inbox IS 'Per-tenant rows older than 30 days are pruned in bounded batches while that tenant is active; Kafka retention and supported replay window must be shorter.';
