-- Control-plane identity alias preserves existing Knowledge ACL/history ownership.
-- NULL keeps the legacy principal UUID lookup. Only privileged provisioning can write.
ALTER TABLE knowledge_auth_memberships ADD COLUMN delegated_identity_id uuid;
CREATE UNIQUE INDEX knowledge_memberships_delegated_identity_unique
 ON knowledge_auth_memberships(tenant_id,COALESCE(delegated_identity_id,principal_id));
