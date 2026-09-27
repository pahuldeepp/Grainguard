DROP INDEX saga_binding_unpublished;
CREATE INDEX saga_binding_unpublished ON saga_binding_requests (tenant_id, completed_at, command_id)
  WHERE outcome = 'succeeded' AND published_at IS NULL;
