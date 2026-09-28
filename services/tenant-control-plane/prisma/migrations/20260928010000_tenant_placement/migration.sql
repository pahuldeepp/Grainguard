-- Authoritative explicit placement. Existing tenants retain the legacy physical
-- bundle as s1. Explicit greenfield mode registers all four offline until proven
-- bootstrap activation. Only the trusted migration connection may set this mode.
DO $$ BEGIN
  IF coalesce(nullif(current_setting('greenguard.bootstrap_mode',true),''),'legacy') NOT IN ('legacy','greenfield') THEN
    RAISE EXCEPTION 'unknown trusted placement bootstrap mode';
  END IF;
END $$;
CREATE TABLE shard_registry (
  shard_id TEXT PRIMARY KEY CHECK (shard_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  shard_incarnation UUID NOT NULL DEFAULT gen_random_uuid(),
  state TEXT NOT NULL DEFAULT 'offline' CHECK (state IN ('active','draining','offline')),
  configuration_version BIGINT NOT NULL DEFAULT 1 CHECK (configuration_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO shard_registry (shard_id,state) VALUES
  ('s1',CASE WHEN current_setting('greenguard.bootstrap_mode',true)='greenfield' THEN 'offline' ELSE 'active' END),
  ('s2','offline'),('s3','offline'),('s4','offline');

-- The ring suggests placement ONLY at onboarding. A versioned persisted policy
-- makes that decision auditable; edits never change existing organization rows.
CREATE TABLE placement_ring_versions (
  ring_version BIGINT PRIMARY KEY CHECK (ring_version > 0),
  algorithm TEXT NOT NULL CHECK (algorithm = 'sha256-v1'),
  virtual_nodes INTEGER NOT NULL CHECK (virtual_nodes BETWEEN 1 AND 1024),
  shard_ids TEXT[] NOT NULL CHECK (cardinality(shard_ids) BETWEEN 1 AND 64)
);
INSERT INTO placement_ring_versions VALUES (1,'sha256-v1',128,
  CASE WHEN current_setting('greenguard.bootstrap_mode',true)='greenfield' THEN ARRAY['s1','s2','s3','s4'] ELSE ARRAY['s1'] END);
CREATE TABLE placement_policy (
  policy_id TEXT PRIMARY KEY CHECK (policy_id = 'default'),
  ring_version BIGINT NOT NULL REFERENCES placement_ring_versions(ring_version)
);
INSERT INTO placement_policy VALUES ('default',1);

ALTER TABLE organizations
  ADD COLUMN shard_id TEXT NOT NULL DEFAULT 's1' REFERENCES shard_registry(shard_id),
  ADD COLUMN placement_state TEXT NOT NULL DEFAULT 'active'
    CHECK (placement_state IN ('active','quiescing','activating')),
  ADD COLUMN initial_placement_ring_version BIGINT REFERENCES placement_ring_versions(ring_version),
  ADD COLUMN initial_placement_method TEXT NOT NULL DEFAULT 'legacy' CHECK (initial_placement_method IN ('legacy','ring','override'));

CREATE TABLE placement_moves (
  tenant_id UUID NOT NULL REFERENCES organizations(tenant_id),
  operation_id UUID NOT NULL,
  expected_epoch BIGINT NOT NULL CHECK (expected_epoch > 0),
  source_shard_id TEXT NOT NULL REFERENCES shard_registry(shard_id),
  target_shard_id TEXT NOT NULL REFERENCES shard_registry(shard_id),
  state TEXT NOT NULL CHECK (state IN ('preparing','quiescing','switched','completed','aborted')),
  resulting_epoch BIGINT CHECK (resulting_epoch > expected_epoch),
  receipts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(receipts) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, operation_id),
  CHECK (source_shard_id <> target_shard_id),
  CHECK ((state IN ('preparing','quiescing')) = (resulting_epoch IS NULL))
);
-- Pessimistic lock order: organization first, then operation. The partial index
-- is a second line of defence against two controllers moving one tenant.
CREATE UNIQUE INDEX placement_moves_one_live ON placement_moves(tenant_id)
  WHERE state IN ('preparing','quiescing','switched');

CREATE FUNCTION enforce_placement_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.routing_epoch < OLD.routing_epoch OR
     (NEW.shard_id <> OLD.shard_id AND NEW.routing_epoch <= OLD.routing_epoch) THEN
    RAISE EXCEPTION 'placement epoch must advance when ownership changes';
  END IF;
  IF NEW.shard_id <> OLD.shard_id AND NOT EXISTS (
    SELECT 1 FROM placement_moves m
     WHERE m.tenant_id=OLD.tenant_id AND m.source_shard_id=OLD.shard_id
       AND m.target_shard_id=NEW.shard_id AND m.expected_epoch=OLD.routing_epoch
       AND m.resulting_epoch=NEW.routing_epoch AND m.state='switched'
       AND m.receipts ?& ARRAY['source_fenced','target_prepared','copy_verified']
       AND m.receipts->'source_fenced'->'verified'='true'::jsonb
       AND m.receipts->'target_prepared'->'verified'='true'::jsonb
       AND m.receipts->'copy_verified'->'verified'='true'::jsonb
  ) THEN
    RAISE EXCEPTION 'ownership change requires a matching switched move receipt';
  END IF;
  -- Runtime cannot manufacture an epoch bump or resume admission outside its
  -- durable operation. Privileged recovery operators remain a separate audited
  -- control path; operational roles have no such privileges.
  IF current_user='control_app' AND
    (NEW.routing_epoch<>OLD.routing_epoch OR NEW.placement_state<>OLD.placement_state) AND NOT EXISTS (
      SELECT 1 FROM placement_moves m WHERE m.tenant_id=OLD.tenant_id AND (
        (NEW.placement_state='quiescing' AND OLD.placement_state='active' AND NEW.routing_epoch=OLD.routing_epoch
          AND m.state='quiescing' AND m.source_shard_id=OLD.shard_id AND m.expected_epoch=OLD.routing_epoch)
        OR (NEW.placement_state='activating' AND OLD.placement_state='quiescing' AND m.state='switched' AND m.resulting_epoch=NEW.routing_epoch
          AND m.expected_epoch=OLD.routing_epoch AND m.source_shard_id=OLD.shard_id AND m.target_shard_id=NEW.shard_id)
        OR (NEW.placement_state='active' AND OLD.placement_state='activating' AND NEW.routing_epoch=OLD.routing_epoch
          AND m.state='completed' AND m.target_shard_id=NEW.shard_id AND m.resulting_epoch=NEW.routing_epoch
          AND m.receipts->'target_activated'->'verified'='true'::jsonb)
        OR (NEW.placement_state='active' AND OLD.placement_state IN ('active','quiescing')
          AND NEW.shard_id=OLD.shard_id AND NEW.routing_epoch>OLD.routing_epoch AND m.state='aborted'
          AND m.source_shard_id=OLD.shard_id AND m.expected_epoch=OLD.routing_epoch AND m.resulting_epoch=NEW.routing_epoch
          AND m.receipts->'targets_unactivated'->'verified'='true'::jsonb
          AND m.receipts->'source_reactivated'->'verified'='true'::jsonb)
      )
  ) THEN
    RAISE EXCEPTION 'placement transition requires a matching durable move';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_placement_epoch BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION enforce_placement_epoch();

CREATE FUNCTION enforce_shard_incarnation_rotation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.shard_incarnation <> OLD.shard_incarnation AND
    (OLD.state <> 'offline' OR NEW.state <> 'offline' OR NEW.configuration_version <> OLD.configuration_version + 1) THEN
    RAISE EXCEPTION 'incarnation rotation requires offline shard and next configuration version';
  END IF;
  IF NEW.configuration_version < OLD.configuration_version THEN
    RAISE EXCEPTION 'shard configuration version cannot regress';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shard_incarnation_rotation BEFORE UPDATE ON shard_registry
  FOR EACH ROW EXECUTE FUNCTION enforce_shard_incarnation_rotation();

-- History must remain reconstructible from the version persisted at onboarding.
CREATE FUNCTION immutable_placement_ring() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'placement ring versions are immutable; insert a new version';
END $$;
CREATE TRIGGER placement_ring_immutable BEFORE UPDATE OR DELETE ON placement_ring_versions
  FOR EACH ROW EXECUTE FUNCTION immutable_placement_ring();

ALTER TABLE shard_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE shard_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY registry_metadata ON shard_registry FOR SELECT TO control_app USING (true);
CREATE POLICY registry_operator ON shard_registry TO control_migrator USING (true) WITH CHECK (true);
ALTER TABLE placement_ring_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_ring_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY ring_metadata ON placement_ring_versions FOR SELECT TO control_app USING (true);
CREATE POLICY ring_operator ON placement_ring_versions TO control_migrator USING (true) WITH CHECK (true);
ALTER TABLE placement_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY policy_metadata ON placement_policy FOR SELECT TO control_app USING (true);
CREATE POLICY policy_operator ON placement_policy TO control_migrator USING (true) WITH CHECK (true);
ALTER TABLE placement_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_moves FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON placement_moves
  USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT ON shard_registry, placement_ring_versions, placement_policy TO control_app;
GRANT SELECT, INSERT ON placement_moves TO control_app;
GRANT UPDATE (state, resulting_epoch, receipts, updated_at) ON placement_moves TO control_app;
GRANT UPDATE (shard_id, routing_epoch, placement_state) ON organizations TO control_app;
