-- Stage 10d: publish the versioned contact row directly through logical CDC.
-- PostgreSQL remains the canonical store; consumers project it into their own
-- stores. A row with both destinations NULL is a versioned cleared/tombstone
-- snapshot and is retained (never physically deleted).
DO $$
DECLARE
  constraint_row record;
  matches integer := 0;
BEGIN
  -- Generated check names vary depending on whether the source migration has
  -- already been normalized. Match the exact all-null rejection predicate so
  -- the email and SMS format checks cannot be removed by name collision.
  FOR constraint_row IN
    SELECT conname,
           regexp_replace(lower(pg_get_constraintdef(oid)), '[^a-z_]', '', 'g') AS normalized
      FROM pg_constraint
     WHERE conrelid = 'public.notification_contacts'::regclass
       AND contype = 'c'
  LOOP
    IF constraint_row.normalized IN (
      'checkemail_toisnotnullorsms_toisnotnull',
      'checksms_toisnotnulloremail_toisnotnull'
    ) THEN
      matches := matches + 1;
      EXECUTE format('ALTER TABLE public.notification_contacts DROP CONSTRAINT %I', constraint_row.conname);
    END IF;
  END LOOP;
  IF matches > 1 THEN
    RAISE EXCEPTION 'expected at most one notification contact non-empty check, found %', matches;
  END IF;
END $$;

-- cdc_reader may read only this dedicated PII-bearing table through its explicit
-- table grant and policy. It receives no broader control-plane table access here.
GRANT SELECT ON TABLE public.notification_contacts TO cdc_reader;
CREATE POLICY cdc_notification_contacts_snapshot ON public.notification_contacts
  FOR SELECT TO cdc_reader USING (true);
CREATE PUBLICATION greenguard_control_notification_contacts
  FOR TABLE public.notification_contacts
  WITH (publish = 'insert, update');
