-- Stage 08 tenant hardening. Forward-only (review O5).
-- The dispatch, redrive and dead-letter scans used open-ended session policies keyed on
-- app.scope, a GUC jobs_app sets itself: any code slip under such a scope could read every
-- tenant's rows. Replace them with fixed SECURITY DEFINER selectors (the ADR-0011 pattern
-- used by telemetry, saga and hardware) that return identifiers only; every payload,
-- last_error and state read/update then happens inside that tenant's RLS transaction.
-- available_at is returned by the dispatch selector only because it orders the batch and
-- feeds the dispatch-lag metric; it is scheduling metadata, not tenant content.
-- Batches are clamped to 1..1000 (the dispatcher default is 50, the redrive default 100).

DROP POLICY dispatch_scan ON dispatch_outbox;
DROP POLICY redrive_scan ON notification_intents;
DROP POLICY dead_scan ON dead_letter_outbox;

-- FORCE RLS applies to the owner too: read-only owner scans used only by the selectors.
CREATE POLICY jobs_migrator_scan ON dispatch_outbox FOR SELECT TO jobs_migrator USING (true);
CREATE POLICY jobs_migrator_scan ON notification_intents FOR SELECT TO jobs_migrator USING (true);
CREATE POLICY jobs_migrator_scan ON dead_letter_outbox FOR SELECT TO jobs_migrator USING (true);

CREATE FUNCTION jobs_due_dispatch_refs(p_limit integer)
RETURNS TABLE(tenant_id uuid, intent_id uuid, available_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.tenant_id, o.intent_id, o.available_at FROM dispatch_outbox o
  WHERE o.dispatched_at IS NULL AND o.available_at <= now()
  ORDER BY o.available_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000);
$$;

CREATE FUNCTION jobs_dead_intent_refs(p_limit integer)
RETURNS TABLE(tenant_id uuid, intent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.tenant_id, i.intent_id FROM notification_intents i
  WHERE i.status = 'dead'
  ORDER BY i.dead_at NULLS FIRST, i.intent_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000);
$$;

CREATE FUNCTION jobs_dead_letter_refs(p_limit integer)
RETURNS TABLE(tenant_id uuid, intent_id uuid, delivery_generation integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.tenant_id, d.intent_id, d.delivery_generation FROM dead_letter_outbox d
  WHERE d.published_at IS NULL
  ORDER BY d.dead_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000);
$$;

REVOKE ALL ON FUNCTION jobs_due_dispatch_refs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION jobs_dead_intent_refs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION jobs_dead_letter_refs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_due_dispatch_refs(integer) TO jobs_app;
GRANT EXECUTE ON FUNCTION jobs_dead_intent_refs(integer) TO jobs_app;
GRANT EXECUTE ON FUNCTION jobs_dead_letter_refs(integer) TO jobs_app;
