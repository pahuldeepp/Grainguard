-- Deterministic malformed Kafka records must not stall an entire partition.
-- Store only the offset and error class, never the potentially sensitive payload.
CREATE TABLE billing_inbox.source_rejections (
  topic text NOT NULL,
  partition integer NOT NULL,
  source_offset bigint NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (topic, partition, source_offset)
);
GRANT SELECT, INSERT ON billing_inbox.source_rejections TO billing_app;
