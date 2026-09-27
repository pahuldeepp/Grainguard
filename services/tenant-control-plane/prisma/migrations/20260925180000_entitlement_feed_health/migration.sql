-- Entitlement feed health (ADR-0020). applied_at keeps meaning "when this plan
-- version was applied"; freshness is a separate per-partition heartbeat so a paid
-- plan that has not changed is still honored while the feed is healthy, and the
-- free defaults apply only when the feed itself is stale. Forward-only.
-- Not tenant data: one row per broker partition, no tenant_id, so no RLS. It has
-- no DELETE grant; the row per partition is bounded by the partition count.
-- Concurrency: optimistic, monotonic upsert (GREATEST) so a late heartbeat can
-- never move verified_at backwards.
CREATE TABLE entitlement_feed_health (
  partition_id integer PRIMARY KEY CHECK (partition_id >= 0),
  verified_at timestamptz NOT NULL
);
CREATE FUNCTION entitlement_feed_fresh(max_age interval DEFAULT interval '5 minutes')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT COALESCE(min(verified_at) >= now() - max_age, false) FROM entitlement_feed_health
$$;
REVOKE ALL ON FUNCTION entitlement_feed_fresh(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION entitlement_feed_fresh(interval) TO control_app;
GRANT USAGE ON SCHEMA public TO control_entitlement_projector;
GRANT SELECT, INSERT, UPDATE ON entitlement_feed_health TO control_entitlement_projector;
