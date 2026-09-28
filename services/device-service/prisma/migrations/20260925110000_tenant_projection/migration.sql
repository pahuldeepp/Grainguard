-- 09a: the control plane owns tenants; inventory holds an ordered local projection.
-- Existing rows from the Stage 02 inventory owner become version-one snapshots.
ALTER TABLE tenants ADD COLUMN state text NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD COLUMN home_region text NOT NULL DEFAULT 'local';
ALTER TABLE tenants ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE tenants ADD CONSTRAINT tenants_state_check CHECK (state IN ('active','suspended','deleting'));
ALTER TABLE tenants ADD CONSTRAINT tenants_version_check CHECK (version > 0);
ALTER TABLE tenants ADD CONSTRAINT tenants_home_region_check CHECK (length(home_region) BETWEEN 1 AND 64);

-- The normal API principal can read tenant context but cannot create or alter it.
REVOKE INSERT ON tenants FROM inventory_app;
GRANT SELECT ON tenants TO inventory_projector;
GRANT INSERT ON tenants TO inventory_projector;
GRANT UPDATE (name, state, home_region, version) ON tenants TO inventory_projector;
-- FORCE RLS and tenant_isolation from the foundation migration apply to both roles.
-- Monotonic version updates are checked in the projector's UPSERT predicate.
