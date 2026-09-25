-- A participant command has one definitive result. Retries may carry a new
-- result_id, but cannot change the already recorded outcome.
ALTER TABLE saga_result_inbox
  ADD CONSTRAINT saga_result_command_once UNIQUE (tenant_id, command_id);
