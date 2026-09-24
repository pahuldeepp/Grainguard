-- Stage 06d jobs-worker ledger. Forward-only: there is no down migration; a failed deploy is
-- recovered by a new forward migration (review O5).
--
-- Concurrency (ADR-0002 / review P3):
--   * notification_intents: pessimistic. The dispatcher locks one due intent with
--     SELECT ... FOR UPDATE SKIP LOCKED inside its tenant transaction, so two dispatchers never
--     publish the same intent concurrently and a busy row is skipped rather than waited on.
--   * Receipts update status with a guarded compare-and-set (WHERE status IN (...)), so a late
--     or duplicate receipt can never move a terminal intent.
--   * inbox: the primary key makes a redelivered Kafka record a no-op.
CREATE TABLE inbox (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  source_topic text NOT NULL,
  source_partition integer NOT NULL,
  source_offset bigint NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE notification_intents (
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  alert_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  transition_version bigint NOT NULL CHECK (transition_version > 0),
  transition text NOT NULL CHECK (transition IN ('alert.opened', 'alert.escalated', 'alert.resolved')),
  severity text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatched', 'sent', 'failed', 'suppressed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  correlation_id uuid NOT NULL,
  traceparent text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  PRIMARY KEY (tenant_id, intent_id),
  UNIQUE (intent_id),
  UNIQUE (tenant_id, episode_id, transition_version, channel),
  FOREIGN KEY (tenant_id, source_event_id) REFERENCES inbox (tenant_id, event_id)
);

-- Dispatch outbox: one row per intent, written in the same transaction as the intent.
-- It holds identifiers only (no alert content). dispatched_at is set instead of deleting.
CREATE TABLE dispatch_outbox (
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  PRIMARY KEY (tenant_id, intent_id),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES notification_intents (tenant_id, intent_id)
);
CREATE INDEX dispatch_outbox_due ON dispatch_outbox (available_at) WHERE dispatched_at IS NULL;

ALTER TABLE inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE dispatch_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON notification_intents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON dispatch_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Documented, narrow exemption: the dispatcher scan (app.scope = 'dispatch-scan', set
-- transaction-locally with no tenant) may READ due outbox identifiers across tenants.
-- It cannot write, and every intent read/update happens afterwards inside WithTenant.
CREATE POLICY dispatch_scan ON dispatch_outbox FOR SELECT
  USING (current_setting('app.scope', true) = 'dispatch-scan' AND dispatched_at IS NULL);

-- No DELETE: the ledger is append/update only.
GRANT SELECT, INSERT ON inbox TO jobs_app;
GRANT SELECT, INSERT, UPDATE ON notification_intents TO jobs_app;
GRANT SELECT, INSERT, UPDATE ON dispatch_outbox TO jobs_app;
