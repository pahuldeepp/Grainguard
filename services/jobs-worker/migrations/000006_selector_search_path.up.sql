-- Pin temporary objects behind trusted public objects in SECURITY DEFINER functions.
-- PostgreSQL searches pg_temp first for relations/types unless it is explicitly listed.
ALTER FUNCTION jobs_due_dispatch_refs(integer) SET search_path = public, pg_temp;
ALTER FUNCTION jobs_dead_intent_refs(integer) SET search_path = public, pg_temp;
ALTER FUNCTION jobs_dead_letter_refs(integer) SET search_path = public, pg_temp;
