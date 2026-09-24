-- R1: snapshot access across tenants is restricted to the immutable outbox.
-- The table remains FORCE RLS; runtime tenant_isolation is unchanged.
-- Executed by the owning migrator, never by the replication login.
GRANT USAGE ON SCHEMA public TO cdc_reader;
GRANT SELECT ON TABLE public.outbox_events TO cdc_reader;
CREATE POLICY cdc_outbox_snapshot ON public.outbox_events
  FOR SELECT TO cdc_reader USING (true);
CREATE PUBLICATION greenguard_outbox FOR TABLE public.outbox_events
  WITH (publish = 'insert');
