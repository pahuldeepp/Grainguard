-- Fence receipts across operator redrives and durably retry dead-letter publication.
-- Both rows are updated under the intent's tenant transaction. The DLQ publisher locks
-- one outbox row with FOR UPDATE SKIP LOCKED and confirms before marking it published.
CREATE TABLE dead_letter_outbox (
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  delivery_generation integer NOT NULL CHECK (delivery_generation >= 0),
  channel text NOT NULL,
  attempts integer NOT NULL,
  last_error text NOT NULL,
  first_attempt_at timestamptz NOT NULL,
  last_attempt_at timestamptz NOT NULL,
  dead_at timestamptz NOT NULL,
  published_at timestamptz,
  PRIMARY KEY (tenant_id, intent_id, delivery_generation),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES notification_intents (tenant_id, intent_id)
);
CREATE INDEX dead_letter_outbox_pending ON dead_letter_outbox (dead_at) WHERE published_at IS NULL;
ALTER TABLE dead_letter_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letter_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dead_letter_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY dead_scan ON dead_letter_outbox FOR SELECT
  USING (current_setting('app.scope', true) = 'dead-scan' AND published_at IS NULL);
GRANT SELECT, INSERT, UPDATE ON dead_letter_outbox TO jobs_app;
