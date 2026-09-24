-- Stage 07a: one database owns saga state. The start transaction inserts the saga,
-- first command and audit row together. Transitions will lock the saga row with
-- SELECT ... FOR UPDATE; the version and fencing token reject stale workers.
CREATE TABLE provisioning_sagas (
  tenant_id uuid NOT NULL,
  saga_id uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash bytea NOT NULL CHECK (length(request_hash) = 32),
  device_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'reserving' CHECK (state IN
    ('reserving', 'configuring', 'activating', 'active', 'compensating', 'compensated', 'repair_required')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  fencing_token bigint NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, saga_id),
  UNIQUE (tenant_id, idempotency_key)
);
-- The database, not a process lease, arbitrates conflicting claims. A terminal
-- compensation releases the claim; an active device continues to own its asset.
CREATE UNIQUE INDEX provisioning_asset_claim ON provisioning_sagas (tenant_id, asset_id)
  WHERE state NOT IN ('compensated', 'repair_required');

CREATE TABLE saga_command_outbox (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL DEFAULT gen_random_uuid(),
  saga_id uuid NOT NULL,
  step text NOT NULL CHECK (step IN ('asset.reserve', 'asset.configure', 'inventory.activate',
                                    'binding.await', 'asset.release', 'inventory.deactivate')),
  saga_version bigint NOT NULL CHECK (saga_version > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (tenant_id, command_id),
  UNIQUE (tenant_id, saga_id, saga_version, step),
  FOREIGN KEY (tenant_id, saga_id) REFERENCES provisioning_sagas (tenant_id, saga_id)
);
CREATE INDEX saga_command_pending ON saga_command_outbox (created_at, command_id)
  WHERE published_at IS NULL;

CREATE TABLE saga_result_inbox (
  tenant_id uuid NOT NULL,
  result_id uuid NOT NULL,
  saga_id uuid NOT NULL,
  command_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'rejected')),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, result_id),
  FOREIGN KEY (tenant_id, saga_id) REFERENCES provisioning_sagas (tenant_id, saga_id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES saga_command_outbox (tenant_id, command_id)
);

CREATE TABLE saga_audit (
  tenant_id uuid NOT NULL,
  audit_id uuid NOT NULL DEFAULT gen_random_uuid(),
  saga_id uuid NOT NULL,
  version bigint NOT NULL,
  action text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, audit_id),
  UNIQUE (tenant_id, saga_id, version, action),
  FOREIGN KEY (tenant_id, saga_id) REFERENCES provisioning_sagas (tenant_id, saga_id)
);

ALTER TABLE provisioning_sagas ENABLE ROW LEVEL SECURITY;
ALTER TABLE provisioning_sagas FORCE ROW LEVEL SECURITY;
ALTER TABLE saga_command_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE saga_command_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE saga_result_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE saga_result_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE saga_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE saga_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON provisioning_sagas
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON saga_command_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON saga_result_inbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON saga_audit
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON provisioning_sagas TO saga_app;
GRANT SELECT, INSERT, UPDATE ON saga_command_outbox TO saga_app;
GRANT SELECT, INSERT ON saga_result_inbox TO saga_app;
GRANT SELECT, INSERT ON saga_audit TO saga_app;
