-- Stage 07 slice 4 (ADR-0013): leased, fenced worker assignment in the saga
-- authority database. Concurrency choice: pessimistic. A worker takes or renews
-- a shard lease with one row-locking UPDATE; every scanning side effect re-reads
-- its lease with SELECT ... FOR SHARE inside the same transaction, so a takeover
-- waits for that transaction and a superseded token cannot commit afterwards.
-- The fencing token only increases; release or expiry never resets it.
CREATE TABLE saga_shard_leases (
  shard smallint PRIMARY KEY CHECK (shard BETWEEN 0 AND 63),
  holder text CHECK (holder IS NULL OR length(holder) BETWEEN 1 AND 200),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  expires_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO saga_shard_leases (shard) SELECT generate_series(0, 63);
GRANT SELECT, UPDATE ON saga_shard_leases TO saga_app;

-- Tenant-to-shard dispatch registry. It is tenant data, so it forces RLS; the
-- worker enumerates it only through the fixed, ID-only selector below.
CREATE TABLE saga_dispatch_tenants (
  tenant_id uuid PRIMARY KEY,
  shard smallint NOT NULL CHECK (shard BETWEEN 0 AND 63),
  registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saga_dispatch_by_shard ON saga_dispatch_tenants (shard, tenant_id);
ALTER TABLE saga_dispatch_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE saga_dispatch_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saga_dispatch_tenants
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON saga_dispatch_tenants TO saga_app;

-- FORCE RLS also applies to the owner. Permit only the owner to scan, and only
-- inside the SECURITY DEFINER selector that returns tenant IDs with work.
CREATE POLICY saga_migrator_scan ON saga_dispatch_tenants TO saga_migrator USING (true);
CREATE POLICY saga_migrator_scan ON provisioning_sagas TO saga_migrator USING (true);
CREATE POLICY saga_migrator_scan ON saga_command_outbox TO saga_migrator USING (true);

-- Backfill uses the same shard function as saga.ShardFor (first SHA-256 byte mod 64).
INSERT INTO saga_dispatch_tenants (tenant_id, shard)
  SELECT DISTINCT tenant_id, get_byte(sha256(convert_to(tenant_id::text, 'UTF8')), 0) % 64
  FROM provisioning_sagas
  ON CONFLICT DO NOTHING;

CREATE INDEX saga_command_pending_tenant ON saga_command_outbox (tenant_id)
  WHERE published_at IS NULL;

CREATE FUNCTION saga_shard_tenants(p_shard smallint, p_after uuid, p_limit integer)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.tenant_id FROM saga_dispatch_tenants d
  WHERE d.shard = p_shard
    AND d.tenant_id > COALESCE(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
    AND (EXISTS (SELECT 1 FROM saga_command_outbox o
                 WHERE o.tenant_id = d.tenant_id AND o.published_at IS NULL)
      OR EXISTS (SELECT 1 FROM provisioning_sagas s
                 WHERE s.tenant_id = d.tenant_id
                   AND s.state IN ('reserving', 'configuring', 'activating', 'compensating')))
  ORDER BY d.tenant_id
  LIMIT LEAST(GREATEST(p_limit, 1), 500);
$$;
REVOKE ALL ON FUNCTION saga_shard_tenants(smallint, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saga_shard_tenants(smallint, uuid, integer) TO saga_app;
