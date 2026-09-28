-- Configuration is an external device operation. Only a verified MQTT acknowledgement
-- may turn its pending receipt into a successful saga result.
ALTER TABLE hardware_command_receipts DROP CONSTRAINT hardware_command_receipts_outcome_check;
ALTER TABLE hardware_command_receipts ADD CONSTRAINT hardware_command_receipts_outcome_check CHECK (outcome IN ('pending','succeeded','rejected'));
ALTER TABLE hardware_assets ADD COLUMN mqtt_ack_secret bytea;
GRANT SELECT,UPDATE ON hardware_command_receipts TO hardware_app;
ALTER TABLE hardware_command_receipts ADD COLUMN request_payload jsonb;
CREATE OR REPLACE FUNCTION hardware_pending_configuration_ids()
RETURNS TABLE(tenant_id uuid, command_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT r.tenant_id,r.command_id FROM hardware_command_receipts r
  WHERE r.step='asset.configure' AND r.outcome='pending'
  ORDER BY r.created_at LIMIT 100;
$$;
REVOKE ALL ON FUNCTION hardware_pending_configuration_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hardware_pending_configuration_ids() TO hardware_app;
CREATE OR REPLACE FUNCTION hardware_unpublished_result_ids()
RETURNS TABLE(tenant_id uuid, result_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT o.tenant_id,o.result_id FROM hardware_result_outbox o
  WHERE o.published_at IS NULL ORDER BY o.created_at LIMIT 100;
$$;
REVOKE ALL ON FUNCTION hardware_unpublished_result_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hardware_unpublished_result_ids() TO hardware_app;
-- FORCE RLS also applies to the migration owner. Permit only that owner to
-- enumerate work inside the two fixed, ID-only SECURITY DEFINER selectors.
CREATE POLICY hardware_migrator_scan ON hardware_command_receipts TO hardware_migrator USING (true);
CREATE POLICY hardware_migrator_scan ON hardware_result_outbox TO hardware_migrator USING (true);
