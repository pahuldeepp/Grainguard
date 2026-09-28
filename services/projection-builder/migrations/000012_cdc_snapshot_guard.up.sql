-- R1 guard. Forward-only (review O5); 000009 is not rewritten.
-- 000009 created the notification publication unconditionally but applied the CDC
-- snapshot policy and grants only IF the cdc_reader role existed. Migrating before the
-- role exists therefore produced a FORCE-RLS outbox the Debezium snapshot reads as zero
-- rows, with no error. This migration fails the deploy instead, and (re)applies the
-- SELECT-only policy and grants idempotently when the role is present.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cdc_reader') THEN
  RAISE EXCEPTION 'CDC role cdc_reader does not exist; create it before migrating greenguard_read (review R1)'
   USING ERRCODE = 'undefined_object';
 END IF;
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO cdc_reader', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO cdc_reader;
GRANT SELECT ON TABLE outbox_events TO cdc_reader;
DROP POLICY IF EXISTS cdc_outbox_snapshot ON outbox_events;
CREATE POLICY cdc_outbox_snapshot ON outbox_events FOR SELECT TO cdc_reader USING (true);
