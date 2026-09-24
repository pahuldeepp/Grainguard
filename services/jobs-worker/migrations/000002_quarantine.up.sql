-- Poison Kafka records whose tenant cannot be trusted. Not a tenant table: it stores source
-- coordinates, a payload hash and the reason only (no payload, no tenant content), so it is
-- insert/select-only for the runtime role and has no RLS. The offset commits only after
-- this row commits (confirmed quarantine).
CREATE TABLE quarantined_events (
  source_topic text NOT NULL,
  source_partition integer NOT NULL,
  source_offset bigint NOT NULL,
  payload_sha256 text NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_topic, source_partition, source_offset)
);
GRANT SELECT, INSERT ON quarantined_events TO jobs_app;
