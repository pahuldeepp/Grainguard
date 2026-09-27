-- ADR-0020 follow-up: every table carries forced RLS (repo invariant, checked by
-- the D02 catalog test). The feed-health table has no tenant column and holds no
-- tenant data, so its single policy is deliberately permissive; write access is
-- still limited by the projector-only grant in the previous migration.
ALTER TABLE entitlement_feed_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement_feed_health FORCE ROW LEVEL SECURITY;
CREATE POLICY feed_health_all ON entitlement_feed_health USING (true) WITH CHECK (true);
