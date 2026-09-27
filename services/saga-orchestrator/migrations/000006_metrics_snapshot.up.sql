-- Stage 07 slice 5: fleet-wide saga gauges for /metrics. These SECURITY DEFINER
-- functions return aggregate counts only: no tenant IDs, saga IDs or row data,
-- so a metrics scrape can never become a cross-tenant read. They rely on the
-- owner-only scan policies created in 000005.
CREATE FUNCTION saga_state_metrics()
RETURNS TABLE(state text, sagas bigint, overdue bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.state, count(*),
    count(*) FILTER (WHERE s.deadline_at <= now()
                     AND s.state NOT IN ('active', 'compensated', 'repair_required'))
  FROM provisioning_sagas s GROUP BY s.state;
$$;
REVOKE ALL ON FUNCTION saga_state_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saga_state_metrics() TO saga_app;

CREATE FUNCTION saga_pending_command_metrics()
RETURNS TABLE(pending bigint, oldest_age_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*), COALESCE(EXTRACT(EPOCH FROM now() - min(o.created_at)), 0)::double precision
  FROM saga_command_outbox o WHERE o.published_at IS NULL;
$$;
REVOKE ALL ON FUNCTION saga_pending_command_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saga_pending_command_metrics() TO saga_app;
