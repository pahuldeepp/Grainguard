-- Dead-intent metadata and the audited redrive transition (owner decision 2026-09-24).
-- Postgres `dead` stays the durable source of truth; the DLQ copy is best effort.
ALTER TABLE notification_intents
  ADD COLUMN first_attempt_at timestamptz,
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN dead_at timestamptz,
  ADD COLUMN redrive_count integer NOT NULL DEFAULT 0 CHECK (redrive_count >= 0);

-- Append-only audit of every dead -> pending redrive: who, when, why and what was reset.
CREATE TABLE intent_redrives (
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  redrive_no integer NOT NULL CHECK (redrive_no > 0),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  previous_attempts integer NOT NULL,
  previous_last_error text,
  previous_dead_at timestamptz,
  redriven_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, intent_id, redrive_no),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES notification_intents (tenant_id, intent_id)
);
ALTER TABLE intent_redrives ENABLE ROW LEVEL SECURITY;
ALTER TABLE intent_redrives FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON intent_redrives
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON intent_redrives TO jobs_app;

-- Documented, narrow exemption for the operator redrive command without a tenant filter:
-- app.scope = 'redrive-scan' may READ dead intents across tenants (identifiers and routing
-- facts only; the ledger holds no contact data). Every write happens afterwards in WithTenant.
CREATE POLICY redrive_scan ON notification_intents FOR SELECT
  USING (current_setting('app.scope', true) = 'redrive-scan' AND status = 'dead');
CREATE INDEX notification_intents_dead ON notification_intents (dead_at) WHERE status = 'dead';
