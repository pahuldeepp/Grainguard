-- A result must name a command from the same saga, not merely two independently
-- valid identifiers. Keep repair-required assets claimed until release is proven.
ALTER TABLE saga_command_outbox
  ADD CONSTRAINT saga_command_saga_identity UNIQUE (tenant_id, saga_id, command_id);
ALTER TABLE saga_result_inbox
  DROP CONSTRAINT saga_result_inbox_tenant_id_saga_id_fkey,
  DROP CONSTRAINT saga_result_inbox_tenant_id_command_id_fkey;
ALTER TABLE saga_result_inbox
  ADD CONSTRAINT saga_result_command_identity
    FOREIGN KEY (tenant_id, saga_id, command_id)
    REFERENCES saga_command_outbox (tenant_id, saga_id, command_id);
DROP INDEX provisioning_asset_claim;
CREATE UNIQUE INDEX provisioning_asset_claim ON provisioning_sagas (tenant_id, asset_id)
  WHERE state <> 'compensated';
