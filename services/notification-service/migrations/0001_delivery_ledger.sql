-- Stage 06d notification-service ledger. Forward-only (review O5): no down migration.
--
-- Concurrency (ADR-0002 / review P3):
--   * deliveries: pessimistic. Each task locks its delivery row with SELECT ... FOR UPDATE for
--     the short "begin attempt" and "record outcome" transactions (never across a provider
--     call). A redelivered duplicate waits, then sees in_progress/terminal and reconciles.
--   * One terminal logical result: PK/UNIQUE on intent_id, and a trigger rejects any change
--     to a row that is already sent/failed/suppressed.
--   * notification_preferences: optimistic version column (low-contention user edits, 409).
CREATE TABLE notification_preferences (
  tenant_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  enabled boolean NOT NULL DEFAULT true,
  min_severity text NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('warning', 'critical')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel)
);

CREATE TABLE deliveries (
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'in_progress', 'retry', 'unknown', 'dead', 'sent', 'failed', 'suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reconciles integer NOT NULL DEFAULT 0 CHECK (reconciles >= 0),
  provider_ref text,
  last_error text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  PRIMARY KEY (tenant_id, intent_id),
  UNIQUE (intent_id),
  CHECK ((status IN ('sent', 'failed', 'suppressed')) = (terminal_at IS NOT NULL))
);

CREATE TABLE delivery_attempts (
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  kind text NOT NULL CHECK (kind IN ('send', 'reconcile', 'preference')),
  outcome text NOT NULL,
  detail text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, intent_id, attempt_no),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES deliveries (tenant_id, intent_id)
);

CREATE FUNCTION deliveries_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('sent', 'failed', 'suppressed') THEN
    RAISE EXCEPTION 'delivery % already has terminal result %', OLD.intent_id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deliveries_terminal_guard BEFORE UPDATE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION deliveries_terminal_guard();

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_preferences
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON deliveries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON delivery_attempts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No DELETE grants anywhere.
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO notifications_app;
GRANT SELECT, INSERT, UPDATE ON deliveries TO notifications_app;
GRANT SELECT, INSERT ON delivery_attempts TO notifications_app;
