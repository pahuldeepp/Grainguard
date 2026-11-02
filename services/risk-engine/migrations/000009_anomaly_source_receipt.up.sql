-- Anomalies can overtake their triggering reading on a separate Kafka topic.
-- Probe the committed threshold receipt before finalizing a decision, independently
-- of Kafka group names. The inbox and assessment/outbox commit in one transaction.
-- This index avoids scanning historical receipts while the bin lock is held.
CREATE INDEX consumer_inbox_telemetry_source_idx
  ON consumer_inbox (tenant_id, event_id) WHERE event_type = 'telemetry.recorded';
