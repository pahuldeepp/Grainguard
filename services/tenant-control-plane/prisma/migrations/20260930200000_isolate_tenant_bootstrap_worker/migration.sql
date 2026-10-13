-- Keep global claim/retry and proof/finalization privileges out of the HTTP
-- application's control_app login. The RDS bootstrap creates the LOGIN
-- tenant_bootstrap_worker and membership in this NOLOGIN group; the worker
-- starts each pooled session with role=control_bootstrap_worker_role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_bootstrap_worker_role') THEN
    RAISE EXCEPTION 'control_bootstrap_worker_role must be provisioned by RDS bootstrap before this migration';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION claim_tenant_bootstrap_job() FROM control_app;
REVOKE EXECUTE ON FUNCTION renew_tenant_bootstrap_job(uuid,uuid,uuid) FROM control_app;
REVOKE EXECUTE ON FUNCTION retry_tenant_bootstrap_job(uuid,uuid,uuid,text) FROM control_app;
GRANT EXECUTE ON FUNCTION claim_tenant_bootstrap_job() TO control_bootstrap_worker_role;
GRANT EXECUTE ON FUNCTION renew_tenant_bootstrap_job(uuid,uuid,uuid) TO control_bootstrap_worker_role;
GRANT EXECUTE ON FUNCTION retry_tenant_bootstrap_job(uuid,uuid,uuid,text) TO control_bootstrap_worker_role;

REVOKE UPDATE ON tenant_bootstrap_jobs FROM control_app;
REVOKE UPDATE (state, attempts, claim_token, lease_until, next_attempt_at,
  prepared_receipts, active_receipts, last_error_code, updated_at, completed_at)
  ON tenant_bootstrap_jobs FROM control_app;
REVOKE ALL ON tenant_bootstrap_jobs FROM control_bootstrap_worker_role;
GRANT SELECT ON tenant_bootstrap_jobs TO control_bootstrap_worker_role;
GRANT UPDATE (state, attempts, claim_token, lease_until, next_attempt_at,
  prepared_receipts, active_receipts, last_error_code, updated_at, completed_at)
  ON tenant_bootstrap_jobs TO control_bootstrap_worker_role;
CREATE POLICY bootstrap_worker_tenant_access ON tenant_bootstrap_jobs
  TO control_bootstrap_worker_role
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The worker finalizer runs under tenant scope and performs the same narrowly
-- scoped membership + activation + outbox transaction as the trusted API code.
GRANT SELECT ON organizations, memberships, identities, shard_registry TO control_bootstrap_worker_role;
GRANT UPDATE (state, updated_at) ON organizations TO control_bootstrap_worker_role;
GRANT INSERT ON memberships, membership_events, outbox_events TO control_bootstrap_worker_role;
CREATE POLICY bootstrap_worker_registry_read ON shard_registry
  FOR SELECT TO control_bootstrap_worker_role USING (true);

GRANT CONNECT ON DATABASE greenguard_control TO control_bootstrap_worker_role;
GRANT USAGE ON SCHEMA public TO control_bootstrap_worker_role;
