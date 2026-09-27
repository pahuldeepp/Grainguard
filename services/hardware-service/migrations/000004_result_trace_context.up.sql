-- Stage 07d: a result echoes the saga command's W3C trace context (ADR-0004,
-- Saga section) so its Kafka header continues the saga's trace after a restart.
-- Nullable and additive; rows written before this migration publish without one.
ALTER TABLE hardware_result_outbox
  ADD COLUMN traceparent text CHECK (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$');
