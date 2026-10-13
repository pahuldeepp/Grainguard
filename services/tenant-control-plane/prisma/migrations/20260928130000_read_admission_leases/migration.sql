-- A route TTL is not a cutover lease. Lease issuance and response admission
-- serialize with organization changes. Cutover waits for release or DB-clock expiry.
CREATE TABLE placement_read_leases (
  tenant_id UUID NOT NULL REFERENCES organizations(tenant_id),
  lease_id UUID NOT NULL,
  shard_id TEXT NOT NULL REFERENCES shard_registry(shard_id),
  shard_incarnation UUID NOT NULL,
  placement_epoch BIGINT NOT NULL CHECK (placement_epoch > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(tenant_id,lease_id)
);
CREATE INDEX placement_read_leases_drain ON placement_read_leases(tenant_id,expires_at);
ALTER TABLE placement_read_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_read_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON placement_read_leases
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON placement_read_leases TO control_app;

CREATE FUNCTION enforce_read_lease_drain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.routing_epoch<>OLD.routing_epoch OR NEW.shard_id<>OLD.shard_id)
     AND EXISTS (SELECT 1 FROM placement_read_leases
       WHERE tenant_id=OLD.tenant_id AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'placement read leases must drain before changing ownership';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_read_lease_drain BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION enforce_read_lease_drain();
