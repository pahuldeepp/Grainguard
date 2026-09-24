-- Consumer infrastructure state, with no tenant data: tenant RLS is not applicable.
-- Optimistic monotonic (raw position, canonical offset, source time) comparisons
-- in the consumer fence redelivery. Topic recreation requires an operator reset
-- while ingest admission is stopped; lower offsets never silently refresh a feed.
CREATE TABLE binding_feed_checkpoints (
  partition_id integer PRIMARY KEY CHECK (partition_id >= 0),
  source_time timestamptz NOT NULL,
  source_position text NOT NULL CHECK (length(source_position) BETWEEN 1 AND 128),
  raw_position bigint NOT NULL CHECK (raw_position >= 0),
  consumed_offset bigint NOT NULL CHECK (consumed_offset >= 0),
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  partition_count integer NOT NULL CHECK (partition_count > 0 AND partition_id < partition_count)
);
GRANT SELECT, INSERT ON binding_feed_checkpoints TO telemetry_app;
GRANT UPDATE (source_time, source_position, raw_position, consumed_offset, consumed_at, partition_count)
  ON binding_feed_checkpoints TO telemetry_app;
