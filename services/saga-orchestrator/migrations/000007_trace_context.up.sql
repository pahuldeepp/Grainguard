-- Stage 07d: one W3C trace context per saga (ADR-0004, Saga section). The start
-- request's validated traceparent is stored on the saga row; a saga started
-- without one, or a pre-migration row, gets one generated root trace the first
-- time a command is queued, stored here so every later command reuses it.
-- Nullable and additive: existing rows and the tenant RLS policies are unchanged,
-- and writes happen only in transactions that already hold the saga row lock
-- (SELECT ... FOR UPDATE, ADR-0013), so no new lock ordering is introduced.
ALTER TABLE provisioning_sagas
  ADD COLUMN traceparent text CHECK (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$'),
  ADD COLUMN trace_origin text CHECK (trace_origin IN ('propagated', 'generated')),
  ADD CONSTRAINT provisioning_trace_origin CHECK ((traceparent IS NULL) = (trace_origin IS NULL));

-- The command row carries the exact context it is published with, so a replay
-- under the original command identity also keeps the original trace.
ALTER TABLE saga_command_outbox
  ADD COLUMN traceparent text CHECK (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$');
