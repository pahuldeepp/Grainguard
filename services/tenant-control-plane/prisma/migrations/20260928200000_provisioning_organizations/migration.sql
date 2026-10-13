-- Tenant requests remain non-routable until every shard owner has acknowledged
-- ownership. Existing active tenants are unchanged.
ALTER TABLE organizations
  DROP CONSTRAINT organizations_state_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_state_check
  CHECK (state IN ('provisioning', 'active', 'suspended', 'deleting'));

