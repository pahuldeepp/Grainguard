CREATE DATABASE IF NOT EXISTS greenguard_analytics;

CREATE TABLE IF NOT EXISTS greenguard_analytics.telemetry_events
(
    event_id UUID,
    tenant_id UUID,
    site_id Nullable(UUID),
    bin_id Nullable(UUID),
    device_id UUID,
    reading_id UUID,
    schema_version UInt8,
    observed_at DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    temperature_c Nullable(Float32),
    relative_humidity_percent Nullable(Float32),
    co2_ppm Nullable(Float32),
    grain_moisture_percent Nullable(Float32),
    source_topic LowCardinality(String),
    source_partition UInt32,
    source_offset UInt64,
    event_sha256 FixedString(64),
    event_json String,
    data_origin LowCardinality(String) DEFAULT 'kafka'
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(observed_at)
ORDER BY (tenant_id, event_id)
TTL toDateTime(observed_at) + INTERVAL 90 DAY DELETE;

-- The canonical v2 contract includes sensor-level observations that do not
-- fit the typed aggregate columns above. Keep the canonical event alongside
-- those projections so ClickHouse never silently drops valid v2 fields.
ALTER TABLE greenguard_analytics.telemetry_events
    ADD COLUMN IF NOT EXISTS event_json String AFTER event_sha256;
