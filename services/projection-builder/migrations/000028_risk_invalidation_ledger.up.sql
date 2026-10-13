-- Immutable withdrawals are retained even when their assessment has not arrived.
-- Inbox admission and tenant watermark locking serialize all effects for a
-- tenant; event identity is the ledger key. Multiple explicit withdrawal events
-- may name one assessment; no arrival-order update can resurrect it.
SET LOCAL lock_timeout='2s';
CREATE TABLE risk_assessment_invalidations (
 consumer_name text NOT NULL DEFAULT 'projection-builder' CHECK(consumer_name='projection-builder'),
 tenant_id uuid NOT NULL,
 event_id uuid NOT NULL,
 assessment_id uuid NOT NULL,
 assessment_version bigint NOT NULL CHECK(assessment_version > 0),
 device_id uuid NOT NULL,
 payload jsonb NOT NULL,
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,event_id),
 FOREIGN KEY(consumer_name,tenant_id,event_id) REFERENCES consumer_inbox(consumer_name,tenant_id,event_id)
);
CREATE INDEX risk_assessment_invalidations_target ON risk_assessment_invalidations(tenant_id,assessment_id);
ALTER TABLE risk_assessment_invalidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_assessment_invalidations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON risk_assessment_invalidations
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON risk_assessment_invalidations FROM PUBLIC,projection_app,read_query;
GRANT SELECT,INSERT ON risk_assessment_invalidations TO projection_app;
GRANT SELECT ON risk_assessment_invalidations TO read_query;
