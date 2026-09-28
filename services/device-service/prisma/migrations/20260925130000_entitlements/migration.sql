-- The billing projection is monotonic. Runtime may read only; a dedicated
-- projector role may insert/update. All access is tenant-scoped and FORCE RLS.
CREATE TABLE tenant_entitlements (
  tenant_id uuid PRIMARY KEY,
  plan_key text NOT NULL,
  plan_version bigint NOT NULL CHECK (plan_version > 0),
  limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'object'),
  source_version bigint NOT NULL CHECK (source_version > 0),
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_entitlements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON tenant_entitlements TO inventory_app;
GRANT SELECT, INSERT, UPDATE ON tenant_entitlements TO inventory_projector;

-- A narrow definer function takes the tenant row lock without granting the
-- runtime role UPDATE on tenant identity or lifecycle columns.
CREATE FUNCTION inventory_lock_tenant_for_quota(p_tenant uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE found boolean;
BEGIN
  IF p_tenant IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN false;
  END IF;
  SELECT true INTO found FROM tenants WHERE tenant_id = p_tenant FOR UPDATE;
  RETURN COALESCE(found, false);
END $$;
REVOKE ALL ON FUNCTION inventory_lock_tenant_for_quota(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_lock_tenant_for_quota(uuid) TO inventory_app;
