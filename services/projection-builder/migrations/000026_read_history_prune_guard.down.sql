-- Intentionally do not restore the previous age-only partition DROP behavior.
-- Reverting that behavior without a Cassandra completeness gate can lose the
-- only queryable copy of telemetry. Rollback must preserve this safety guard.
DO $$ BEGIN
 RAISE EXCEPTION 'rollback refused: age-only read-history pruning is unsafe';
END $$;
