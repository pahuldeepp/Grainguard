-- Stage 08 tenant hardening. Forward-only (review O5); runs in one transaction.
-- risk_assessments, outbox_events and risk_assessment_invalidations had globally unique
-- identifiers (assessment_id, event_id). A second tenant inserting the same identifier got
-- a unique violation: a cross-tenant existence oracle. Every key becomes (tenant_id, id).
-- Identifiers stay deterministic per tenant (uuid5 over tenant and source), so existing
-- rows cannot conflict and no data changes. RLS, FORCE RLS and grants are untouched.
-- CDC note: the Debezium raw record key for outbox_events becomes {tenant_id, event_id};
-- the raw topic has one partition and the transformer keys canonical records from the
-- value, as it already does for the projection notification outbox.

-- risk_assessments: the invalidation FK depends on the 000003 unique pair; repoint it
-- to the new composite primary key.
ALTER TABLE risk_assessment_invalidations
  DROP CONSTRAINT risk_assessment_invalidations_tenant_assessment_fkey;
ALTER TABLE risk_assessments DROP CONSTRAINT risk_assessments_pkey;
ALTER TABLE risk_assessments DROP CONSTRAINT risk_assessments_tenant_assessment_unique;
ALTER TABLE risk_assessments ADD PRIMARY KEY (tenant_id, assessment_id);
ALTER TABLE risk_assessments DROP CONSTRAINT risk_assessments_event_id_key;
ALTER TABLE risk_assessments
  ADD CONSTRAINT risk_assessments_tenant_event_unique UNIQUE (tenant_id, event_id);
ALTER TABLE risk_assessment_invalidations
  ADD CONSTRAINT risk_assessment_invalidations_tenant_assessment_fkey
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES risk_assessments (tenant_id, assessment_id);

ALTER TABLE risk_assessment_invalidations DROP CONSTRAINT risk_assessment_invalidations_event_id_key;
ALTER TABLE risk_assessment_invalidations
  ADD CONSTRAINT risk_assessment_invalidations_tenant_event_unique UNIQUE (tenant_id, event_id);

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_pkey;
ALTER TABLE outbox_events ADD PRIMARY KEY (tenant_id, event_id);
