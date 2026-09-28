DROP POLICY feed_health_all ON entitlement_feed_health;
ALTER TABLE entitlement_feed_health NO FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlement_feed_health DISABLE ROW LEVEL SECURITY;
