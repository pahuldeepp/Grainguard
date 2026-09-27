-- Stage 07d: a binding.await result echoes the saga command's W3C trace context
-- (ADR-0004, Saga section). Nullable and additive: pre-migration rows publish
-- without one; RLS policies and grants (INSERT on the table) are unchanged.
ALTER TABLE saga_binding_requests
  ADD COLUMN traceparent text CHECK (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$');
