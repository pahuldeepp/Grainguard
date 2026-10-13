-- Never restore cross-tenant maintenance routines which silently observe zero
-- rows under FORCE ROW LEVEL SECURITY. Rolling this migration back would make
-- the Cassandra proof/prune gate unsafe; restore from a tested forward fix.
DO $$ BEGIN
 RAISE EXCEPTION 'rollback refused: cross-tenant history verification must remain RLS-safe';
END $$;
