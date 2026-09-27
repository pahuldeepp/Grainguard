ALTER TABLE saga_audit ADD COLUMN actor_sub text;
ALTER TABLE saga_audit ADD COLUMN reason text;
ALTER TABLE saga_audit DROP CONSTRAINT saga_audit_tenant_id_saga_id_version_action_key;

CREATE INDEX provisioning_deadline_due ON provisioning_sagas (tenant_id, deadline_at, saga_id)
  WHERE state NOT IN ('active', 'compensated', 'repair_required');
