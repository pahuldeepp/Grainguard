-- Stage 07d: a saga result echoes the command's W3C trace context (ADR-0004,
-- Saga section). Nullable and additive; RLS and grants are unchanged.
ALTER TABLE inventory_saga_result_outbox
  ADD COLUMN traceparent text CHECK (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$');
